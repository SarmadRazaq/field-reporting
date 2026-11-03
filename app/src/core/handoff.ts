import type { LocalReport, Problem, TransientReason } from './types';

/**
 * While the app is in the background, a native sender (Android) uploads the
 * reports instead of the JS uploader, so sending doesn't depend on JS timers
 * that React Native pauses there. The outbox pauses, hands over the reports
 * whose photos are ready, and takes them back with what happened to each.
 *
 * The native side never writes the reports database: it only reports back,
 * and the outbox applies that. The server stays the truth either way: a
 * report the native sender committed is answered "committed" if the JS
 * uploader sends its manifest again.
 */

/** One report as the native sender gets it. */
export interface HandoffReport {
  id: string;
  description: string;
  createdAt: string | null;
  images: { id: string; path: string; size: number; sha256: string }[];
}

/** What happened to one handed-over report. */
export type HandoffResult =
  | { id: string; kind: 'uploaded'; at: number }
  | { id: string; kind: 'needs_attention'; problem: Problem }
  | {
      id: string;
      kind: 'pending';
      /** Bytes the server confirmed per photo id. */
      uploadedBytes: Record<string, number>;
      issue: { reason: TransientReason; message: string; at: number; since: number } | null;
    };

/** Reports the native sender can take: waiting, with every photo prepared. */
export function handoffReport(r: LocalReport): HandoffReport | null {
  const images = r.images.map(i => (i.processed ? { id: i.id, ...i.processed } : null));
  if (images.some(i => i === null)) return null;
  return {
    id: r.id,
    description: r.description,
    createdAt: r.createdAt,
    images: images.map(i => ({ id: i!.id, path: i!.path, size: i!.size, sha256: i!.sha256 })),
  };
}

/** Parse what the native side sent back; anything malformed is dropped rather than applied. */
export function parseHandoffResults(json: string | null | undefined): HandoffResult[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is HandoffResult =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as HandoffResult).id === 'string' &&
        ['uploaded', 'needs_attention', 'pending'].includes((r as HandoffResult).kind),
    );
  } catch {
    return [];
  }
}
