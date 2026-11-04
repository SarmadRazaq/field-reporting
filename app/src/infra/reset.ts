import { COMMIT_SETTLE_MS, type ResetOutcome } from '../core/outbox';
import { TIMEOUTS } from '../core/protocol';
import type { ResetPhase, ResetProgress } from '../core/resetProgress';
// background.ts imports this module too; both only use each other inside functions, so the cycle is safe.
import { releaseNativeSender } from './background';
import { outbox } from './outbox';
import { deleteAllServerReports } from './serverApi';
import { clearSettings, lastResetStore, resetMarker } from './settings';

export type ServerResult = { server: 'kept' | 'deleted' } | { server: 'failed'; message: string };

/** What happened on the server, and to any report whose commit was already on its way. */
export type ResetResult = ServerResult & { inFlight: ResetOutcome };

const NOTHING_IN_FLIGHT: ResetOutcome = { reachedServer: [], mayHaveReachedServer: [] };

/** Bounds of each wait, for the countdown. The native one mirrors BackgroundSender.STOP_WAIT_MS. */
const NATIVE_STOP_MS = 70_000;
const BOUNDS: Record<ResetPhase, number | null> = {
  stopping: NATIVE_STOP_MS,
  confirming: COMMIT_SETTLE_MS,
  deleting: null,
  server: TIMEOUTS.controlMs,
};

// ── Progress, for any screen that wants it ──────────────────────────────────
// Kept here rather than in a screen, so leaving the screen doesn't lose it.

let progress: ResetProgress = { phase: 'idle' };
let running: Promise<ResetResult> | null = null;
const listeners = new Set<() => void>();

function setPhase(phase: ResetPhase | 'idle') {
  const now = Date.now();
  progress = phase === 'idle' ? { phase } : { phase, startedAt: now, until: BOUNDS[phase] === null ? null : now + BOUNDS[phase]! };
  for (const l of listeners) l();
}

export const resetProgress = {
  get: (): ResetProgress => progress,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The outcome of the last Start over, until dismissed; survives the app being closed. */
export function lastResetResult(): ResetResult | ServerResult | null {
  const v = lastResetStore.get();
  return v && typeof v === 'object' && 'server' in v ? (v as ResetResult | ServerResult) : null;
}

export function dismissResetResult() {
  lastResetStore.clear();
  for (const l of listeners) l();
}

function remember(result: ResetResult | ServerResult) {
  lastResetStore.set(result);
  for (const l of listeners) l();
}

/**
 * Start over. Everything on the phone goes first and never waits on the
 * network: reports (sent, waiting and refused), drafts, every photo and cache
 * file, and settings. Then, only if asked, the server's reports too.
 *
 * Runs to the end even if the screen that started it goes away; a second call
 * while one is running joins it. The outcome is stored for whoever looks next.
 */
export function startOver({ includeServer }: { includeServer: boolean }): Promise<ResetResult> {
  running ??= run(includeServer).finally(() => {
    running = null;
    setPhase('idle');
  });
  return running;
}

async function run(includeServer: boolean): Promise<ResetResult> {
  lastResetStore.clear();
  const inFlight = await resetPhone();
  let result: ResetResult = { server: 'kept', inFlight };
  if (includeServer) {
    setPhase('server');
    // Deleting the server's reports also removes anything that landed during the reset.
    result = { ...(await deleteServerReports()), inFlight: NOTHING_IN_FLIGHT };
  }
  remember(result);
  return result;
}

/**
 * The marker makes a reset that is killed halfway finish on the next launch,
 * instead of leaving some reports or photos behind.
 */
async function resetPhone(): Promise<ResetOutcome> {
  resetMarker.set();
  // The native sender first: stopped, its results file gone, and anything it sent or
  // had a commit out for reported like the outbox's own, instead of landing unannounced.
  setPhase('stopping');
  const native = await releaseNativeSender();
  const box = outbox();
  setPhase(box.getSnapshot().activity?.stage === 'committing' ? 'confirming' : 'deleting');
  const outcome = await box.reset(native);
  clearSettings(); // also removes the marker
  return outcome;
}

/** Called at launch, before the outbox loads anything. */
export async function finishInterruptedReset(): Promise<void> {
  if (resetMarker.isSet()) await resetPhone();
}

/** Try the server again after it failed; updates the stored outcome. */
export async function retryServerDelete(): Promise<ServerResult> {
  setPhase('server');
  try {
    const result = await deleteServerReports();
    remember(result);
    return result;
  } finally {
    setPhase('idle');
  }
}

export async function deleteServerReports(): Promise<ServerResult> {
  try {
    await deleteAllServerReports();
    return { server: 'deleted' };
  } catch (e) {
    return { server: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}
