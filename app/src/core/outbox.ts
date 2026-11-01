import { ChunkSizer } from './chunking';
import { deliver } from './deliver';
import { Drafts, newImage } from './drafts';
import { photoPaths } from './processing';
import type { Clock, ContactStore, FileStore, HttpClient, ImageEncoder, Logger, ReportRepo } from './ports';
import { NetworkError, systemClock } from './ports';
import { ProtocolClient } from './protocol';
import { BACKOFF, Cancelled, backoffMs, toFailure } from './retry';
import { ReportStore, imagePaths } from './store';
import { PENDING_STATES, type Activity, type LocalReport, type OutboxSnapshot } from './types';

export type { SubmitResult } from './drafts';

export interface OutboxDeps {
  repo: ReportRepo;
  files: FileStore;
  encoder: ImageEncoder;
  http: HttpClient;
  newId: () => string;
  clock?: Clock;
  random?: () => number;
  log?: Logger;
  contact?: ContactStore;
}

/** How often "the server answered" is written to disk at most. */
const CONTACT_SAVE_MS = 10_000;

/**
 * The reports on this phone and the uploader that sends them. The UI calls
 * commands and subscribes to snapshots; works without React or any screen.
 * Composing lives in `drafts`; everything after Save lives here.
 *
 * One drain runs at a time and delivers reports one at a time, oldest first
 * unless the inspector asked for one to go first: on 2G, parallel uploads only
 * make every report slower.
 */
export class Outbox {
  readonly drafts: Drafts;
  private readonly store: ReportStore;
  private snapshot: OutboxSnapshot = { ready: false, reports: [], activity: null, lastContactAt: null };
  private listeners = new Set<() => void>();
  private activity: Activity | null = null;

  private running: Promise<void> | null = null;
  private rerun = false;
  private wakeTimer: unknown = null;
  /** Aborts the requests of the current drain: for reset, stop, and "send this first". */
  private run: AbortController | null = null;
  /** Last word from the OS. Only stretches backoff; never stops an attempt. */
  private online = true;
  private lastContactAt: number | null;
  private contactSavedAt = 0;
  private readonly http: HttpClient;
  private readonly chunks = new ChunkSizer();
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly log: Logger;

  constructor(private readonly deps: OutboxDeps) {
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? (() => {});
    this.lastContactAt = deps.contact?.get() ?? null;
    this.store = new ReportStore(deps.repo, deps.files, () => this.emit());
    this.drafts = new Drafts({
      store: this.store,
      files: deps.files,
      encoder: deps.encoder,
      newId: deps.newId,
      clock: this.clock,
      log: this.log,
      submitted: () => this.kick('submit'),
    });
    // Any HTTP answer, even an error status, proves the server is reachable.
    this.http = {
      send: async req => {
        const res = await deps.http.send(req);
        this.noteContact();
        return res;
      },
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.snapshot.ready) return;
    await this.store.load();
    await this.removeOrphanFiles();
    this.emit(true);
    this.drafts.resume();
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
    this.online = online;
    if (!online) return;
    this.retryNow('connectivity');
  }

  /**
   * Move a waiting report to the front. If another report is being sent, its
   * current chunk is abandoned (the bytes already on the server are kept) and
   * this one starts straight away.
   */
  async sendFirst(id: string): Promise<void> {
    const r = this.store.get(id);
    if (!r || !PENDING_STATES.includes(r.state)) return;
    await this.store.write({ ...r, sendFirstAt: this.clock.now(), nextAttemptAt: null });
    if (this.running && this.activity?.reportId !== id) {
      this.log(`[outbox] ${id} goes first; pausing ${this.activity?.reportId ?? 'current work'}`);
      this.run?.abort();
    }
    this.kick('send first');
  }

  /** Forget backoff timers and try every pending report now. */
  retryNow(reason: string): void {
    for (const r of this.store.all()) {
      if (PENDING_STATES.includes(r.state) && r.nextAttemptAt !== null) this.store.patch({ ...r, nextAttemptAt: null });
    }
    this.kick(reason);
  }

  /** Resolves when the current drain (if any) has finished. For tests and background tasks. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** True if any submitted report is not yet on the server. */
  hasPendingWork(): boolean {
    return this.store.all().some(r => PENDING_STATES.includes(r.state));
  }

  // ── Reports that need the user ─────────────────────────────────────────────

  /** Try a refused report again (e.g. after the server was fixed). */
  async retryReport(id: string): Promise<void> {
    const r = this.store.get(id);
    if (r?.state !== 'needs_attention') return;
    const reprocess = r.problem?.code === 'photo_unreadable';
    await this.store.write({
      ...r,
      state: r.images.every(i => i.processed) ? 'uploading' : 'queued',
      images: reprocess ? r.images.map(i => ({ ...i, processingAttempts: 0, problem: null })) : r.images,
      problem: null,
      attempts: 0,
      nextAttemptAt: null,
      lastIssue: null,
    });
    this.kick('retry');
  }

  /**
   * Swap one photo of a refused report for a new one, keeping the description
   * and the other photos. The server may already hold this report's manifest,
   * which can't change, so the report goes again under new ids; the other
   * photos keep the files already prepared for them. Returns the new id.
   */
  async replacePhoto(id: string, imageId: string, uri: string): Promise<string | null> {
    const r = this.store.get(id);
    if (r?.state !== 'needs_attention' || !r.images.some(i => i.id === imageId)) return null;
    const freshId = this.deps.newId();
    const dest = photoPaths(this.deps.files.photosDir, freshId).source;
    const { bytes } = await this.deps.files.importPhoto(uri, dest);
    const replacement = await this.store.write({
      ...r,
      id: this.deps.newId(),
      state: 'queued',
      images: r.images.map(i =>
        i.id === imageId ? newImage(freshId, dest, bytes) : { ...i, id: this.deps.newId(), uploadedBytes: 0 },
      ),
      updatedAt: this.clock.now(),
      problem: null,
      attempts: 0,
      nextAttemptAt: null,
      lastIssue: null,
      sendFirstAt: null,
    });
    await this.store.discard(r, new Set(imagePaths(replacement)));
    this.kick('photo replaced');
    return replacement.id;
  }

  /** Delete a refused report from the phone. */
  async discardReport(id: string): Promise<void> {
    const r = this.store.get(id);
    if (r?.state !== 'needs_attention') return;
    await this.store.discard(r);
  }

  /** Remove "uploaded" receipts from the list. They are already on the server. */
  async clearUploaded(): Promise<void> {
    for (const r of this.store.all()) if (r.state === 'uploaded') await this.store.discard(r);
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  /**
   * Wipe everything this outbox owns on the device. Stops the uploader and
   * photo preparation first and bumps the epoch, so a reply or a photo that
   * finishes late cannot write a report back after the wipe.
   */
  async reset(): Promise<void> {
    this.store.epoch += 1;
    this.run?.abort();
    this.clearWake();
    await this.idle();
    await this.drafts.idle();
    this.rerun = false;
    this.lastContactAt = null;
    await this.store.clear();
    await this.deps.files.clearAll();
    this.activity = null;
    this.emit();
    this.log('[outbox] reset');
  }

  /**
   * Stop uploading and refuse further writes, leaving everything on disk.
   * Equivalent to the process dying, as far as the stored state is concerned.
   */
  async stop(): Promise<void> {
    this.store.epoch += 1;
    this.run?.abort();
    this.clearWake();
    this.rerun = false;
    await this.idle();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async drain(): Promise<void> {
    const epoch = this.store.epoch;
    this.clearWake();

    while (epoch === this.store.epoch) {
      const next = this.nextDue();
      if (!next) break;
      const run = new AbortController();
      this.run = run;
      const protocol = new ProtocolClient(this.http, run.signal);
      try {
        await deliver(
          {
            protocol,
            files: this.deps.files,
            encoder: this.deps.encoder,
            clock: this.clock,
            chunks: this.chunks,
            log: this.log,
            save: r => this.store.write(r, epoch),
            progress: a => this.setActivity(a, epoch),
          },
          next,
        );
        this.log(`[outbox] ${next.id} uploaded`);
      } catch (e) {
        if (epoch !== this.store.epoch || e instanceof Cancelled) return;
        if (run.signal.aborted && e instanceof NetworkError && e.kind === 'aborted') {
          // Pre-empted by "send this first". Not a failure: progress is on disk, pick the next due report.
          this.setActivity(null, epoch);
          continue;
        }
        let failure;
        try {
          failure = toFailure(e);
        } catch (bug) {
          // Not a network or server answer: a bug or an unexpected device error. Back off and keep the report.
          this.log(`[outbox] ${next.id} unexpected error: ${String(bug)}`);
          failure = { type: 'transient' as const, reason: 'server' as const, message: 'Unexpected error on this phone' };
        }
        const current = this.store.get(next.id) ?? next;
        this.setActivity(null, epoch);

        if (failure.type === 'permanent') {
          this.log(`[outbox] ${next.id} needs attention: ${failure.problem.message}`);
          await this.store.write(
            { ...current, state: 'needs_attention', problem: failure.problem, attempts: 0, nextAttemptAt: null },
            epoch,
          );
          continue;
        }
        const attempts = current.attempts + 1;
        const cap = this.online ? BACKOFF.maxMs : BACKOFF.offlineMaxMs;
        const wait = Math.max(backoffMs(attempts, this.random, cap), failure.type === 'transient' ? failure.retryAfterMs ?? 0 : 0);
        this.log(`[outbox] ${next.id} attempt ${attempts} failed (${failure.message}); retry in ${Math.round(wait / 1000)}s`);
        await this.store.write(
          {
            ...current,
            attempts,
            nextAttemptAt: this.clock.now() + wait,
            lastIssue: {
              reason: failure.type === 'transient' ? failure.reason : 'server',
              message: failure.message,
              at: this.clock.now(),
              since: current.lastIssue?.since ?? this.clock.now(),
            },
          },
          epoch,
        );
        // A failure usually means the link is down for everyone; wait instead of hammering the next report.
        break;
      }
    }
    if (epoch === this.store.epoch) {
      this.setActivity(null, epoch);
      this.scheduleWake();
    }
  }

  private nextDue(): LocalReport | undefined {
    const now = this.clock.now();
    return this.pending().find(r => r.nextAttemptAt === null || r.nextAttemptAt <= now);
  }

  /** Upload order: reports asked to go first (in the order asked), then oldest first. */
  private pending(): LocalReport[] {
    return this.store
      .all()
      .filter(r => PENDING_STATES.includes(r.state))
      .sort(
        (a, b) =>
          (a.sendFirstAt ?? Infinity) - (b.sendFirstAt ?? Infinity) ||
          (a.createdAt ?? '').localeCompare(b.createdAt ?? ''),
      );
  }

  private noteContact() {
    const now = this.clock.now();
    this.lastContactAt = now;
    if (now - this.contactSavedAt >= CONTACT_SAVE_MS) {
      this.contactSavedAt = now;
      this.deps.contact?.set(now);
      this.emit();
    }
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

  private setActivity(activity: Activity | null, epoch: number) {
    if (epoch !== this.store.epoch) return;
    this.activity = activity;
    this.emit();
  }

  private async removeOrphanFiles() {
    const referenced = this.store.referencedPaths();
    for (const path of await this.deps.files.list(this.deps.files.photosDir))
      if (!referenced.has(path)) await this.deps.files.remove(path);
  }

  private emit(ready = this.snapshot.ready) {
    this.snapshot = {
      ready,
      reports: this.store.all().sort((a, b) => (b.createdAt ?? '￿').localeCompare(a.createdAt ?? '￿')),
      activity: this.activity,
      lastContactAt: this.lastContactAt,
    };
    for (const l of this.listeners) l();
  }
}
