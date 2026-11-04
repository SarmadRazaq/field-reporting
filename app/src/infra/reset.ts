import type { ResetOutcome } from '../core/outbox';
// background.ts imports this module too; both only use each other inside functions, so the cycle is safe.
import { releaseNativeSender } from './background';
import { outbox } from './outbox';
import { deleteAllServerReports } from './serverApi';
import { clearSettings, resetMarker } from './settings';

export type ServerResult = { server: 'kept' | 'deleted' } | { server: 'failed'; message: string };

/** What happened on the server, and to any report whose commit was already on its way. */
export type ResetResult = ServerResult & { inFlight: ResetOutcome };

const NOTHING_IN_FLIGHT: ResetOutcome = { reachedServer: [], mayHaveReachedServer: [] };

/**
 * Start over. Everything on the phone goes first and never waits on the
 * network: reports (sent, waiting and refused), drafts, every photo and cache
 * file, and settings. Then, only if asked, the server's reports too.
 */
export async function startOver({ includeServer }: { includeServer: boolean }): Promise<ResetResult> {
  const inFlight = await resetPhone();
  if (!includeServer) return { server: 'kept', inFlight };
  // Deleting the server's reports also removes anything that landed during the reset.
  return { ...(await deleteServerReports()), inFlight: NOTHING_IN_FLIGHT };
}

/**
 * The marker makes a reset that is killed halfway finish on the next launch,
 * instead of leaving some reports or photos behind.
 */
async function resetPhone(): Promise<ResetOutcome> {
  resetMarker.set();
  // The native sender first: stopped, its results file gone, and anything it sent or
  // had a commit out for reported like the outbox's own, instead of landing unannounced.
  const native = await releaseNativeSender();
  const outcome = await outbox().reset(native);
  clearSettings(); // also removes the marker
  return outcome;
}

/** Called at launch, before the outbox loads anything. */
export async function finishInterruptedReset(): Promise<void> {
  if (resetMarker.isSet()) await resetPhone();
}

export async function deleteServerReports(): Promise<ServerResult> {
  try {
    await deleteAllServerReports();
    return { server: 'deleted' };
  } catch (e) {
    return { server: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}
