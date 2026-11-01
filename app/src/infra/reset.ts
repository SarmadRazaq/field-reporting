import { outbox } from './outbox';
import { deleteAllServerReports } from './serverApi';
import { clearSettings, resetMarker } from './settings';

export type ResetResult = { server: 'kept' | 'deleted' } | { server: 'failed'; message: string };

/**
 * Start over. Everything on the phone goes first and never waits on the
 * network: reports (sent, waiting and refused), drafts, every photo and cache
 * file, and settings. Then, only if asked, the server's reports too.
 */
export async function startOver({ includeServer }: { includeServer: boolean }): Promise<ResetResult> {
  await resetPhone();
  if (!includeServer) return { server: 'kept' };
  try {
    await deleteAllServerReports();
    return { server: 'deleted' };
  } catch (e) {
    return { server: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The marker makes a reset that is killed halfway finish on the next launch,
 * instead of leaving some reports or photos behind.
 */
async function resetPhone() {
  resetMarker.set();
  await outbox().reset();
  clearSettings(); // also removes the marker
}

/** Called at launch, before the outbox loads anything. */
export async function finishInterruptedReset(): Promise<void> {
  if (resetMarker.isSet()) await resetPhone();
}

export async function deleteServerReports(): Promise<ResetResult> {
  try {
    await deleteAllServerReports();
    return { server: 'deleted' };
  } catch (e) {
    return { server: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}
