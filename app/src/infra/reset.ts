import { outbox } from './outbox';
import { deleteAllServerReports } from './serverApi';
import { clearSettings } from './settings';

export type ResetResult = { server: 'kept' | 'deleted' } | { server: 'failed'; message: string };

/**
 * Start over. Everything on the phone goes first and never waits on the
 * network: reports (sent, waiting and refused), drafts, every photo and cache
 * file, and settings. Then, only if asked, the server's reports too.
 */
export async function startOver({ includeServer }: { includeServer: boolean }): Promise<ResetResult> {
  await outbox().reset();
  clearSettings();
  if (!includeServer) return { server: 'kept' };
  try {
    await deleteAllServerReports();
    return { server: 'deleted' };
  } catch (e) {
    return { server: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteServerReports(): Promise<ResetResult> {
  try {
    await deleteAllServerReports();
    return { server: 'deleted' };
  } catch (e) {
    return { server: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}
