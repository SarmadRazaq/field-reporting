import { PENDING_STATES, type Activity, type LocalReport, type OutboxSnapshot } from './types';

/**
 * What to tell the user. Kept out of the UI so the wording rules are testable:
 * "Saved" only ever means "on this phone", "Sent" only ever means "the server
 * confirmed it", and the two never appear in one chip or sentence.
 */

/** One per report state; each maps to one chip colour and icon. */
export type StatusKind = 'draft' | 'saved' | 'waiting' | 'sending' | 'sent' | 'refused';

export interface ReportStatus {
  kind: StatusKind;
  /** The chip text. */
  label: string;
  /** A second line for detail screens and hero cards. */
  detail?: string;
  /** For `waiting`: when the next try happens. */
  retryInMs?: number;
  /** 0..1 while bytes are moving. */
  progress?: number;
}

export function photosReceived(r: LocalReport): number {
  return r.images.filter(i => i.processed && i.uploadedBytes >= i.processed.size).length;
}

export function reportBytes(r: LocalReport): number {
  return r.images.reduce((sum, i) => sum + (i.processed?.size ?? i.sourceBytes), 0);
}

const fraction = (a: Activity) => (a.bytesTotal > 0 ? Math.min(1, a.bytesSent / a.bytesTotal) : 0);

export function describeReport(r: LocalReport, activity: Activity | null, now: number): ReportStatus {
  const active = activity?.reportId === r.id ? activity : null;
  switch (r.state) {
    case 'draft':
      return { kind: 'draft', label: 'Draft', detail: 'Not saved as a report yet' };
    case 'uploaded':
      return { kind: 'sent', label: 'Sent', detail: r.uploadedAt ? `Confirmed by the server at ${clockTime(r.uploadedAt)}` : undefined };
    case 'needs_attention':
      return { kind: 'refused', label: "Couldn't send", detail: r.problem?.message ?? 'The server refused this report' };
  }
  if (active?.stage === 'processing')
    return { kind: 'sending', label: 'Preparing photos', detail: `Photo ${active.imageIndex + 1} of ${active.imageCount}` };
  if (active?.stage === 'committing')
    return { kind: 'sending', label: 'Sending', detail: 'Waiting for the server to confirm', progress: 1 };
  if (active)
    return {
      kind: 'sending',
      label: 'Sending',
      detail: `${photosReceived(r)} of ${r.images.length} received by the server`,
      progress: fraction(active),
    };
  if (r.lastIssue && r.nextAttemptAt !== null) {
    const retryInMs = Math.max(0, r.nextAttemptAt - now);
    const serverSide = r.lastIssue.reason === 'server' || r.lastIssue.reason === 'busy' || r.lastIssue.reason === 'rate_limited';
    return {
      kind: 'waiting',
      label: serverSide ? 'Server busy' : 'Waiting for signal',
      detail: serverSide ? r.lastIssue.message : 'Sends by itself when there is signal',
      retryInMs,
    };
  }
  return { kind: 'saved', label: 'Saved on this phone', detail: 'Safe even if the app closes' };
}

export type SummaryKind = 'empty' | 'all-sent' | 'sending' | 'waiting' | 'attention';

/** The one connection summary at the top of Reports. */
export interface Summary {
  kind: SummaryKind;
  text: string;
}

export function summarize(snapshot: OutboxSnapshot, now: number): Summary {
  const pending = snapshot.reports.filter(r => PENDING_STATES.includes(r.state));
  const refused = snapshot.reports.filter(r => r.state === 'needs_attention');
  const sent = snapshot.reports.filter(r => r.state === 'uploaded');
  const onPhone = pending.length + refused.length;
  const count = onPhone === 1 ? '1 report on this phone' : `${onPhone} reports on this phone`;

  if (refused.length) return { kind: 'attention', text: refused.length === 1 ? "1 report couldn't send" : `${refused.length} reports couldn't send` };
  if (pending.length) {
    if (snapshot.activity) return { kind: 'sending', text: `Sending · ${count}` };
    const noSignal = pending.some(r => {
      const s = describeReport(r, null, now);
      return s.kind === 'waiting' && s.label === 'Waiting for signal';
    });
    return { kind: 'waiting', text: noSignal ? `No signal · ${count}` : `Waiting · ${count}` };
  }
  if (sent.length) return { kind: 'all-sent', text: 'Nothing waiting on this phone' };
  return { kind: 'empty', text: 'No reports yet' };
}

/** "14 s", "3 min", "about 2 h". */
export function duration(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `about ${Math.round(m / 60)} h`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
