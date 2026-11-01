import { ChunkSizer } from './chunking';
import { deliver } from './deliver';
import { photoPaths } from './processing';
import type { Clock, FileStore, HttpClient, ImageEncoder, Logger, ReportRepo } from './ports';
import { systemClock } from './ports';
import { ProtocolClient } from './protocol';
import { Cancelled, backoffMs, toFailure } from './retry';
import { draftIssues, photoSlotsLeft, type DraftIssue } from './rules';
import { PENDING_STATES, type Activity, type LocalReport, type OutboxSnapshot } from './types';

export interface OutboxDeps {
  repo: ReportRepo;
  files: FileStore;
  encoder: ImageEncoder;
  http: HttpClient;
  newId: () => string;
  clock?: Clock;
  random?: () => number;
  log?: Logger;
}

export type SubmitResult = { ok: true } | { ok: false; issues: DraftIssue[] };

/**
 * The single owner of local reports. The UI calls commands and subscribes to
 * snapshots; the uploader runs inside. Works without React or any screen.
 *
 * One drain runs at a time and delivers reports oldest first, one at a time:
 * on 2G, parallel uploads only make every report slower.
 */
export class Outbox {
  private reports = new Map<string, LocalReport>();
  private snapshot: OutboxSnapshot = { ready: false, reports: [], activity: null };
  private listeners = new Set<() => void>();
  private activity: Activity | null = null;

  private running: Promise<void> | null = null;
  private rerun = false;
  private wakeTimer: unknown = null;
  private abort = new AbortController();
  /** Bumped by reset; any write from an older epoch is refused. */
  private epoch = 0;
  private readonly chunks = new ChunkSizer();
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly log: Logger;

  constructor(private readonly deps: OutboxDeps) {
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? (() => {});
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.snapshot.ready) return;
    for (const report of await this.deps.repo.load()) this.reports.set(report.id, report);
    await this.removeOrphanFiles();
    this.emit(true);
    this.kick('start');
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): OutboxSnapshot => this.snapshot;

  /** Something changed that may let work proceed (submit, app foregrounded, timer). */
  kick(reason: string): void {
    if (!this.snapshot.ready) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.log(`[outbox] drain (${reason})`);
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.rerun) {
        this.rerun = false;
        this.kick('rerun');
      }
    });
  }

  /**
   * The OS says connectivity changed. We never skip work because it says
   * "offline" (2G reports wrongly both ways), but "online" is a good moment to
   * stop waiting out a backoff.
   */
  connectivityChanged(online: boolean): void {
    if (!online) return;
    this.retryNow('connectivity');
  }

  /** Forget backoff timers and try every pending report now. */
  retryNow(reason: string): void {
    for (const r of this.reports.values()) {
      if (PENDING_STATES.includes(r.state) && r.nextAttemptAt !== null) this.reports.set(r.id, { ...r, nextAttemptAt: null });
    }
    this.kick(reason);
  }

  /** Resolves when the current drain (if any) has finished. For tests and background tasks. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** True if any submitted report is not yet on the server. */
  hasPendingWork(): boolean {
    return [...this.reports.values()].some(r => PENDING_STATES.includes(r.state));
  }

  // ── Drafts ─────────────────────────────────────────────────────────────────

  currentDraft(): LocalReport | undefined {
    return [...this.reports.values()].find(r => r.state === 'draft');
  }

  async startDraft(): Promise<LocalReport> {
    const existing = this.currentDraft();
    if (existing) return existing;
    return this.write({
      id: this.deps.newId(),
      description: '',
      createdAt: null,
      updatedAt: this.clock.now(),
      state: 'draft',
      images: [],
      attempts: 0,
      nextAttemptAt: null,
      lastIssue: null,
      problem: null,
      uploadedAt: null,
    });
  }

  async setDescription(draftId: string, description: string): Promise<void> {
    const draft = this.draft(draftId);
    if (draft.description === description) return;
    await this.write({ ...draft, description, updatedAt: this.clock.now() });
  }

  /**
   * Copy picked photos into app storage straight away: picker URIs and caches
   * do not survive a kill. Extra photos beyond the limit are ignored, and the
   * number actually added is returned.
   */
  async addPhotos(draftId: string, uris: string[]): Promise<number> {
    let added = 0;
    for (const uri of uris) {
      const draft = this.draft(draftId);
      if (photoSlotsLeft(draft) === 0) break;
      const id = this.deps.newId();
      const dest = photoPaths(this.deps.files.photosDir, id).source;
      const { bytes } = await this.deps.files.importPhoto(uri, dest);
      await this.write({
        ...this.draft(draftId),
        updatedAt: this.clock.now(),
        images: [
          ...this.draft(draftId).images,
          { id, sourcePath: dest, sourceBytes: bytes, processed: null, processingAttempts: 0, uploadedBytes: 0 },
        ],
      });
      added += 1;
    }
    return added;
  }

  async removePhoto(draftId: string, imageId: string): Promise<void> {
    const draft = this.draft(draftId);
    const image = draft.images.find(i => i.id === imageId);
    if (!image) return;
    await this.write({ ...draft, updatedAt: this.clock.now(), images: draft.images.filter(i => i.id !== imageId) });
    if (image.sourcePath) await this.deps.files.remove(image.sourcePath);
  }

  /** Saves the report on the phone and queues it. Says nothing about the network. */
  async submit(draftId: string): Promise<SubmitResult> {
    const draft = this.draft(draftId);
    const issues = draftIssues(draft);
    if (issues.length) return { ok: false, issues };
    const now = this.clock.now();
    await this.write({
      ...draft,
      description: draft.description.trim(),
      state: 'queued',
      createdAt: new Date(now).toISOString(),
      updatedAt: now,
    });
    this.kick('submit');
    return { ok: true };
  }

  async discardDraft(draftId: string): Promise<void> {
    await this.discard(this.draft(draftId));
  }

  // ── Reports that need the user ─────────────────────────────────────────────

  /** Try a refused report again (e.g. after the server was fixed). */
  async retryReport(id: string): Promise<void> {
    const r = this.reports.get(id);
    if (r?.state !== 'needs_attention') return;
    const reprocess = r.problem?.code === 'photo_unreadable';
    await this.write({
      ...r,
      state: r.images.every(i => i.processed) ? 'uploading' : 'queued',
      images: reprocess ? r.images.map(i => ({ ...i, processingAttempts: 0 })) : r.images,
      problem: null,
      attempts: 0,
      nextAttemptAt: null,
      lastIssue: null,
    });
    this.kick('retry');
  }

  /** Delete a refused report from the phone. */
  async discardReport(id: string): Promise<void> {
    const r = this.reports.get(id);
    if (r?.state !== 'needs_attention') return;
    await this.discard(r);
  }

  /** Remove "uploaded" receipts from the list. They are already on the server. */
  async clearUploaded(): Promise<void> {
    for (const r of [...this.reports.values()]) if (r.state === 'uploaded') await this.discard(r);
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  /**
   * Wipe everything this outbox owns on the device. Stops the uploader first
   * and bumps the epoch, so a reply that arrives late cannot write a report
   * back after the wipe.
   */
  async reset(): Promise<void> {
    this.epoch += 1;
    this.abort.abort();
    this.clearWake();
    await this.idle();
    this.abort = new AbortController();
    this.rerun = false;
    await this.deps.repo.clear();
    await this.deps.files.clearAll();
    this.reports.clear();
    this.activity = null;
    this.emit();
    this.log('[outbox] reset');
  }

  /**
   * Stop uploading and refuse further writes, leaving everything on disk.
   * Equivalent to the process dying, as far as the stored state is concerned.
   */
  async stop(): Promise<void> {
    this.epoch += 1;
    this.abort.abort();
    this.clearWake();
    await this.idle();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async drain(): Promise<void> {
    const epoch = this.epoch;
    const protocol = new ProtocolClient(this.deps.http, this.abort.signal);
    this.clearWake();

    while (epoch === this.epoch) {
      const next = this.nextDue();
      if (!next) break;
      try {
        await deliver(
          {
            protocol,
            files: this.deps.files,
            encoder: this.deps.encoder,
            clock: this.clock,
            chunks: this.chunks,
            log: this.log,
            save: r => this.write(r, epoch),
            progress: a => this.setActivity(a, epoch),
          },
          next,
        );
        this.log(`[outbox] ${next.id} uploaded`);
      } catch (e) {
        if (epoch !== this.epoch || e instanceof Cancelled) return;
        let failure;
        try {
          failure = toFailure(e);
        } catch (bug) {
          // Not a network or server answer: a bug or an unexpected device error. Back off and keep the report.
          this.log(`[outbox] ${next.id} unexpected error: ${String(bug)}`);
          failure = { type: 'transient' as const, reason: 'server' as const, message: 'Unexpected error on this phone' };
        }
        const current = this.reports.get(next.id) ?? next;
        this.setActivity(null, epoch);

        if (failure.type === 'permanent') {
          this.log(`[outbox] ${next.id} needs attention: ${failure.problem.message}`);
          await this.write({ ...current, state: 'needs_attention', problem: failure.problem, attempts: 0, nextAttemptAt: null }, epoch);
          continue;
        }
        const attempts = current.attempts + 1;
        const wait = Math.max(backoffMs(attempts, this.random), failure.type === 'transient' ? failure.retryAfterMs ?? 0 : 0);
        this.log(`[outbox] ${next.id} attempt ${attempts} failed (${failure.message}); retry in ${Math.round(wait / 1000)}s`);
        await this.write(
          {
            ...current,
            attempts,
            nextAttemptAt: this.clock.now() + wait,
            lastIssue: {
              reason: failure.type === 'transient' ? failure.reason : 'server',
              message: failure.message,
              at: this.clock.now(),
            },
          },
          epoch,
        );
        // A failure usually means the link is down for everyone; wait instead of hammering the next report.
        break;
      }
    }
    if (epoch === this.epoch) {
      this.setActivity(null, epoch);
      this.scheduleWake();
    }
  }

  private nextDue(): LocalReport | undefined {
    const now = this.clock.now();
    return this.pending().find(r => r.nextAttemptAt === null || r.nextAttemptAt <= now);
  }

  private pending(): LocalReport[] {
    return [...this.reports.values()]
      .filter(r => PENDING_STATES.includes(r.state))
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  }

  private scheduleWake() {
    const times = this.pending()
      .map(r => r.nextAttemptAt)
      .filter((t): t is number => t !== null);
    if (!times.length) return;
    const delay = Math.max(0, Math.min(...times) - this.clock.now());
    this.wakeTimer = this.clock.setTimeout(() => {
      this.wakeTimer = null;
      this.kick('backoff elapsed');
    }, delay);
  }

  private clearWake() {
    if (this.wakeTimer !== null) this.clock.clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  private draft(id: string): LocalReport {
    const r = this.reports.get(id);
    if (!r || r.state !== 'draft') throw new Error(`No draft ${id}`);
    return r;
  }

  private async discard(r: LocalReport) {
    await this.deps.repo.remove(r.id);
    this.reports.delete(r.id);
    this.emit();
    for (const i of r.images) {
      if (i.sourcePath) await this.deps.files.remove(i.sourcePath);
      if (i.processed) await this.deps.files.remove(i.processed.path);
    }
  }

  /** Persist first, then publish. Refuses writes from a run that a reset has replaced. */
  private async write(report: LocalReport, epoch = this.epoch): Promise<LocalReport> {
    if (epoch !== this.epoch) throw new Cancelled();
    await this.deps.repo.save(report);
    if (epoch !== this.epoch) throw new Cancelled();
    this.reports.set(report.id, report);
    this.emit();
    return report;
  }

  private setActivity(activity: Activity | null, epoch: number) {
    if (epoch !== this.epoch) return;
    this.activity = activity;
    this.emit();
  }

  private async removeOrphanFiles() {
    const referenced = new Set<string>();
    for (const r of this.reports.values())
      for (const i of r.images) {
        if (i.sourcePath) referenced.add(i.sourcePath);
        if (i.processed) referenced.add(i.processed.path);
      }
    for (const path of await this.deps.files.list(this.deps.files.photosDir))
      if (!referenced.has(path)) await this.deps.files.remove(path);
  }

  private emit(ready = this.snapshot.ready) {
    this.snapshot = {
      ready,
      reports: [...this.reports.values()].sort((a, b) => (b.createdAt ?? '￿').localeCompare(a.createdAt ?? '￿')),
      activity: this.activity,
    };
    for (const l of this.listeners) l();
  }
}
