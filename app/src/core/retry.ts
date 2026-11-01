import { NetworkError } from './ports';
import type { Problem, ProblemCode, TransientReason } from './types';

/**
 * Every way an attempt can fail, sorted into what the uploader should do about it.
 *
 *   transient  try again later, on our own (no signal, timeouts, 5xx, 429, 423)
 *   permanent  stop and ask the user; retrying the same bytes would get the same answer
 *   restart    the server no longer knows this report (e.g. it was reset); send the manifest again
 */
export type Failure =
  | { type: 'transient'; reason: TransientReason; message: string; retryAfterMs?: number }
  | { type: 'permanent'; problem: Problem }
  | { type: 'restart'; message: string };

export class DeliveryError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.type === 'permanent' ? failure.problem.message : failure.message);
    this.name = 'DeliveryError';
  }
}

/** The run was cancelled (reset, or the engine stopped). Not a failure. */
export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'Cancelled';
  }
}

const permanent = (code: ProblemCode, message: string, status?: number): Failure => ({
  type: 'permanent',
  problem: { code, message, status },
});

function serverMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') return body.message;
  return undefined;
}

function retryAfterMs(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Classify an HTTP response that was not a success for the step that sent it. */
export function classifyResponse(status: number, body: unknown, headers: Record<string, string> = {}): Failure {
  const detail = serverMessage(body);
  if (status === 408) return { type: 'transient', reason: 'timeout', message: 'The server timed out' };
  if (status === 423 || status === 425)
    return { type: 'transient', reason: 'busy', message: 'The server is still busy with this upload', retryAfterMs: retryAfterMs(headers) };
  if (status === 429)
    return { type: 'transient', reason: 'rate_limited', message: 'The server asked us to slow down', retryAfterMs: retryAfterMs(headers) };
  if (status >= 500)
    return { type: 'transient', reason: 'server', message: `Server error (${status})`, retryAfterMs: retryAfterMs(headers) };
  if (status === 404) return { type: 'restart', message: 'The server no longer has this report' };
  if (status === 413) return permanent('too_large', detail ?? 'The server refused a photo as too large', status);
  if (status === 401 || status === 403) return permanent('forbidden', detail ?? 'The server refused this upload', status);
  if (status === 409) return permanent('conflict', detail ?? 'The server holds a different report with this id', status);
  if (status === 400 || status === 422) return permanent('invalid', detail ?? 'The server rejected this report', status);
  return permanent('refused', detail ?? `The server refused the upload (${status})`, status);
}

export function classifyNetwork(e: NetworkError): Failure {
  if (e.kind === 'timeout') return { type: 'transient', reason: 'timeout', message: 'No answer from the server' };
  return { type: 'transient', reason: 'offline', message: 'No connection' };
}

/** Turn anything thrown during a delivery into a Failure, or rethrow cancellations and bugs. */
export function toFailure(e: unknown): Failure {
  if (e instanceof DeliveryError) return e.failure;
  if (e instanceof NetworkError && e.kind !== 'aborted') return classifyNetwork(e);
  throw e;
}

export const BACKOFF = { baseMs: 2_000, maxMs: 60_000 } as const;

/**
 * Exponential backoff with jitter: 2 s, 4 s, 8 s … capped at 60 s, each scaled
 * to between 50% and 100% so a fleet of phones doesn't retry in lockstep.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF.maxMs, BACKOFF.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + (random() * exp) / 2);
}
