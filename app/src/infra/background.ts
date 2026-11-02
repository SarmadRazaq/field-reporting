import { AppState } from 'react-native';
import BackgroundFetch from 'react-native-background-fetch';
import { summarize } from '../core/status';
import type { OutboxSnapshot } from '../core/types';
import { PENDING_STATES } from '../core/types';
import { outbox } from './outbox';
import { finishInterruptedReset } from './reset';
import { uploadService } from './uploadService';

/**
 * Two layers keep reports moving when the inspector is not looking:
 *
 * 1. While work is waiting, a foreground service (with a "Sending reports"
 *    notification) keeps the process alive, so the uploader simply keeps
 *    running in the background. Android only lets us start it while the app
 *    is visible, so it starts as soon as there is work.
 * 2. If the OS kills the process, or stops the service (Android 15+ allows it
 *    about six hours a day), WorkManager (via background-fetch) wakes a JS
 *    task about every 15 minutes, only when there is a network. Each wake-up
 *    sends until Android says its time is up (about 10 minutes), not just for a
 *    few seconds, so a big report still gets somewhere in this mode.
 *
 * Doze can hold those wake-ups back for an hour or more. The only thing that
 * gets past it is the inspector exempting the app from battery optimisation,
 * which Settings offers (see batteryOptimisation).
 *
 * Both are switched off when nothing is waiting, so a reset or an empty queue
 * leaves nothing scheduled.
 */

const NOTIFY_EVERY_MS = 2_000;
/**
 * Upper bound for one WorkManager wake-up. Android gives a job about 10
 * minutes and then signals a timeout, which stops the uploader early; this
 * cap only matters if that signal never comes.
 */
const WAKE_UP_BUDGET_MS = 9 * 60_000;

/** True while the foreground service is up; then it, not the wake-ups, keeps the uploader going. */
let serviceOn = false;

const pendingCount = (s: OutboxSnapshot) => s.reports.filter(r => PENDING_STATES.includes(r.state)).length;

function notificationText(s: OutboxSnapshot): { title: string; text: string; percent: number } {
  const n = pendingCount(s);
  const title = n === 1 ? 'Sending 1 report' : `Sending ${n} reports`;
  const a = s.activity;
  if (a?.stage === 'uploading' && a.bytesTotal > 0) {
    const percent = Math.floor((a.bytesSent / a.bytesTotal) * 100);
    return { title, text: `Photo ${a.imageIndex + 1} of ${a.imageCount} · ${percent}%`, percent };
  }
  if (a?.stage === 'processing') return { title, text: 'Preparing photos', percent: -1 };
  return { title, text: summarize(s, Date.now()).text, percent: -1 };
}

/** Keeps the foreground service and the WorkManager schedule in step with the outbox. Returns an unsubscribe. */
export function startBackgroundWork(): () => void {
  const box = outbox();
  let fetchOn: boolean | null = null;
  let lastNotify = 0;

  BackgroundFetch.configure(
    {
      minimumFetchInterval: 15,
      stopOnTerminate: false,
      startOnBoot: true,
      enableHeadless: true,
      requiredNetworkType: BackgroundFetch.NETWORK_TYPE_ANY,
    },
    async taskId => {
      await sendForAWhile();
      BackgroundFetch.finish(taskId);
    },
    async taskId => {
      await timeUp();
      BackgroundFetch.finish(taskId);
    },
  ).catch(e => console.warn('[background] configure failed', e));

  // Android stopped the service (daily cap): stop counting on it; the wake-ups carry on,
  // and it's started again the next time the app is opened.
  const unsubscribeStopped = uploadService.onStoppedByAndroid(reason => {
    console.log(`[background] service stopped by Android (${reason}); falling back to scheduled wake-ups`);
    serviceOn = false;
  });

  const sync = async () => {
    const s = box.getSnapshot();
    if (!s.ready) return;
    const waiting = pendingCount(s) > 0;

    if (waiting !== fetchOn) {
      fetchOn = waiting;
      (waiting ? BackgroundFetch.start() : BackgroundFetch.stop()).catch(() => {});
    }

    if (waiting && !serviceOn) {
      if (AppState.currentState !== 'active') return; // Android refuses from the background; try again on return.
      const n = notificationText(s);
      serviceOn = await uploadService.start(n.title, n.text, n.percent);
    } else if (waiting && serviceOn && Date.now() - lastNotify > NOTIFY_EVERY_MS) {
      lastNotify = Date.now();
      const n = notificationText(s);
      uploadService.update(n.title, n.text, n.percent);
    } else if (!waiting && serviceOn) {
      serviceOn = false;
      uploadService.stop();
    }
  };

  const unsubscribe = box.subscribe(() => void sync());
  const appState = AppState.addEventListener('change', next => next === 'active' && void sync());
  void sync();
  return () => {
    unsubscribe();
    appState.remove();
    unsubscribeStopped();
  };
}

/** Run the uploader until the queue is empty or the wake-up's time is up: used by WorkManager wake-ups. */
export async function sendForAWhile(): Promise<void> {
  const box = outbox();
  // A wake-up can come before the app is next opened; never send what an interrupted reset meant to wipe.
  await finishInterruptedReset();
  await box.start();
  box.retryNow('background wake-up');
  await Promise.race([box.idle(), new Promise(r => setTimeout(r, WAKE_UP_BUDGET_MS))]);
}

/**
 * Android is about to end the wake-up. Stop the uploader so no request is cut
 * off mid-write by the process freezing; everything sent so far is on disk and
 * on the server, and the next wake-up (or opening the app) carries on from there.
 * Leaves the uploader alone if the app is on screen, where it should keep going.
 */
async function timeUp(): Promise<void> {
  // On screen, or kept alive by the foreground service: the upload is healthy, only the wake-up ended.
  if (AppState.currentState === 'active' || serviceOn) return;
  await outbox().stop();
}

/**
 * Entry point when Android wakes the app with no UI (process was killed).
 * Registered in index.js.
 */
export async function headlessTask(event: { taskId: string; timeout: boolean }): Promise<void> {
  if (event.timeout) await timeUp();
  else await sendForAWhile();
  BackgroundFetch.finish(event.taskId);
}
