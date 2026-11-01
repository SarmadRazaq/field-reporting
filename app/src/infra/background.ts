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
 * 2. If the OS kills the process anyway, WorkManager (via background-fetch)
 *    wakes a headless JS task about every 15 minutes, only when there is a
 *    network, to send for a while.
 *
 * Both are switched off when nothing is waiting, so a reset or an empty queue
 * leaves nothing scheduled.
 */

const NOTIFY_EVERY_MS = 2_000;
/** How long a WorkManager wake-up sends before handing back. */
const HEADLESS_BUDGET_MS = 25_000;

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
  let serviceOn = false;
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
    taskId => BackgroundFetch.finish(taskId),
  ).catch(e => console.warn('[background] configure failed', e));

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
  };
}

/** Run the uploader for a bounded time: used by WorkManager wake-ups. */
export async function sendForAWhile(): Promise<void> {
  const box = outbox();
  // A wake-up can come before the app is next opened; never send what an interrupted reset meant to wipe.
  await finishInterruptedReset();
  await box.start();
  box.retryNow('background wake-up');
  await Promise.race([box.idle(), new Promise(r => setTimeout(r, HEADLESS_BUDGET_MS))]);
}

/**
 * Entry point when Android wakes the app with no UI (process was killed).
 * Registered in index.js.
 */
export async function headlessTask(event: { taskId: string; timeout: boolean }): Promise<void> {
  if (!event.timeout) await sendForAWhile();
  BackgroundFetch.finish(event.taskId);
}
