/**
 * Where a Start over stands while it waits on something, and how to say so.
 * Every wait has a bound, so the screen can show a countdown that ends,
 * never a spinner that might not.
 */
export type ResetPhase =
  /** Stopping the native background sender and waiting for its last request to end. */
  | 'stopping'
  /** A commit was already sent; waiting to learn whether the server published it. */
  | 'confirming'
  /** Deleting reports, photos and settings on the phone. Never waits on the network. */
  | 'deleting'
  /** Deleting the server's reports, if that was asked for. */
  | 'server';

export type ResetProgress = { phase: 'idle' } | { phase: ResetPhase; startedAt: number; until: number | null };

const TEXT: Record<ResetPhase, string> = {
  stopping: 'Stopping background sending first, so nothing is sent after the reset.',
  confirming: 'Waiting for the server to answer about one report it was already confirming.',
  deleting: 'Deleting everything on this phone.',
  server: 'Deleting the reports on the server.',
};

/** One sentence for what the reset is waiting on, and the seconds left before it stops waiting (null: no wait). */
export function describeReset(p: ResetProgress, now: number): { text: string; secondsLeft: number | null } | null {
  if (p.phase === 'idle') return null;
  const secondsLeft = p.until === null ? null : Math.max(0, Math.ceil((p.until - now) / 1000));
  return { text: TEXT[p.phase], secondsLeft };
}
