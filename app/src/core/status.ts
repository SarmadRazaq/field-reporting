import { PENDING_STATES, type Activity, type LocalReport, type OutboxSnapshot } from './types';

/**
 * What to tell the user. Kept out of the UI so the wording rules are testable:
 * "saved" only ever means "on this phone", "uploaded" only ever means "the
 * server confirmed it", and the two never appear in one sentence.
 */

export type Tone = 'safe' | 'moving' | 'waiting' | 'attention' | 'done';

export interface StatusLine {
  tone: Tone;
  title: string;
  detail?: string;
  /** 0..1 when there is measurable progress. */
  progress?: number;
}

const percent = (a: Activity) => (a.bytesTotal > 0 ? a.bytesSent / a.bytesTotal : 0);

function waitingDetail(r: LocalReport, now: number): string {
  const issue = r.lastIssue;
  const when = r.nextAttemptAt !== null ? retryIn(r.nextAttemptAt - now) : 'soon';
  if (!issue) return 'Waiting to upload';
  switch (issue.reason) {
    case 'offline':
      return `Waiting for signal · next try ${when}`;
    case 'timeout':
      return `Connection stalled · next try ${when}`;
    default:
      return `${issue.message} · next try ${when}`;
  }
}

export function retryIn(ms: number): string {
  if (ms <= 1_000) return 'now';
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `in ${s} s` : `in ${Math.ceil(s / 60)} min`;
}

export function describeReport(r: LocalReport, activity: Activity | null, now: number): StatusLine {
  const active = activity?.reportId === r.id ? activity : null;
  switch (r.state) {
    case 'draft':
      return { tone: 'safe', title: 'Draft', detail: 'Not submitted yet' };
    case 'uploaded':
      return { tone: 'done', title: 'Uploaded', detail: r.uploadedAt ? `Server confirmed at ${clockTime(r.uploadedAt)}` : undefined };
    case 'needs_attention':
      return { tone: 'attention', title: 'Needs your attention', detail: r.problem?.message ?? 'The server refused this report' };
  }
  if (active) {
    if (active.stage === 'processing')
      return { tone: 'moving', title: 'Saved on this phone', detail: `Preparing photo ${active.imageIndex + 1} of ${active.imageCount}` };
    if (active.stage === 'committing')
      return { tone: 'moving', title: 'Upload finishing', detail: 'Waiting for the server to confirm', progress: 1 };
    return {
      tone: 'moving',
      title: 'Uploading',
      detail: `Photo ${active.imageIndex + 1} of ${active.imageCount} · ${Math.floor(percent(active) * 100)}%`,
      progress: percent(active),
    };
  }
  return { tone: 'waiting', title: 'Saved on this phone', detail: waitingDetail(r, now) };
}

/** The one-glance answer at the top of the home screen. */
export function summarize(snapshot: OutboxSnapshot, now: number): StatusLine {
  // Oldest first, the order they upload in, so "report 1 of 3" is the one going first.
  const pending = snapshot.reports
    .filter(r => PENDING_STATES.includes(r.state))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  const attention = snapshot.reports.filter(r => r.state === 'needs_attention');
  const uploaded = snapshot.reports.filter(r => r.state === 'uploaded');

  if (attention.length)
    return {
      tone: 'attention',
      title: attention.length === 1 ? '1 report needs your attention' : `${attention.length} reports need your attention`,
      detail: pending.length ? `${pending.length} more saved on this phone` : undefined,
    };

  if (pending.length) {
    const a = snapshot.activity;
    const n = pending.length;
    if (a && a.stage !== 'processing') {
      const position = pending.findIndex(r => r.id === a.reportId) + 1;
      return {
        tone: 'moving',
        title: `Uploading report ${Math.max(1, position)} of ${n}`,
        detail: a.stage === 'committing' ? 'Waiting for the server to confirm' : `Photo ${a.imageIndex + 1} of ${a.imageCount}`,
        progress: percent(a),
      };
    }
    const offline = pending.some(r => r.lastIssue?.reason === 'offline');
    const reports = n === 1 ? '1 report' : `${n} reports`;
    return {
      tone: a ? 'moving' : 'waiting',
      title: `${reports} saved on this phone`,
      detail: a ? 'Preparing photos' : offline ? 'Waiting for signal. They will go on their own.' : 'They will go on their own.',
    };
  }

  if (uploaded.length) return { tone: 'done', title: 'Everything is on the server' };
  return { tone: 'safe', title: 'No reports yet' };
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
