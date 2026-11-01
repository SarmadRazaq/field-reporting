import type { Clock, FileStore, ImageEncoder, Logger } from './ports';
import { MAX_PROCESSING_ATTEMPTS, photoPaths, processPhoto } from './processing';
import { Cancelled, DeliveryError } from './retry';
import { draftIssues, photoSlotsLeft, type DraftIssue } from './rules';
import type { ReportStore } from './store';
import type { LocalImage, LocalReport } from './types';

export type SubmitResult = { ok: true } | { ok: false; issues: DraftIssue[] };

export interface DraftDeps {
  store: ReportStore;
  files: FileStore;
  encoder: ImageEncoder;
  newId: () => string;
  clock: Clock;
  log: Logger;
  /** A draft became a queued report. */
  submitted: () => void;
}

/** A photo just copied in from the camera or gallery, not yet prepared. */
export function newImage(id: string, sourcePath: string, bytes: number): LocalImage {
  return { id, sourcePath, sourceBytes: bytes, processed: null, processingAttempts: 0, uploadedBytes: 0, problem: null };
}

export function withImage(r: LocalReport, imageId: string, patch: Partial<LocalImage>): LocalReport {
  return { ...r, images: r.images.map(i => (i.id === imageId ? { ...i, ...patch } : i)) };
}

/**
 * The one report being composed.
 *
 * Photos are copied into app storage the moment they are picked (picker URIs
 * don't survive a kill), then prepared in the background one at a time:
 * resized under the cap, checked and hashed. A photo that can't be used is
 * found while the inspector is still on site and can retake it, and a saved
 * report is ready to send straight away.
 */
export class Drafts {
  private preparing: Promise<void> | null = null;
  private again = false;
  /** Set while a submit waits for the photo in hand; preparation stops after it. */
  private holding = false;

  constructor(private readonly deps: DraftDeps) {}

  current(): LocalReport | undefined {
    return this.deps.store.all().find(r => r.state === 'draft');
  }

  async start(): Promise<LocalReport> {
    const existing = this.current();
    if (existing) return existing;
    return this.deps.store.write({
      id: this.deps.newId(),
      description: '',
      createdAt: null,
      updatedAt: this.deps.clock.now(),
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
    await this.deps.store.write({ ...draft, description, updatedAt: this.deps.clock.now() });
  }

  /** Copy picked photos in. Extra photos beyond the limit are ignored; returns how many were added. */
  async addPhotos(draftId: string, uris: string[]): Promise<number> {
    let added = 0;
    try {
      for (const uri of uris) {
        if (photoSlotsLeft(this.draft(draftId)) === 0) break;
        const id = this.deps.newId();
        const dest = photoPaths(this.deps.files.photosDir, id).source;
        const { bytes } = await this.deps.files.importPhoto(uri, dest);
        const draft = this.draft(draftId);
        await this.deps.store.write({
          ...draft,
          updatedAt: this.deps.clock.now(),
          images: [...draft.images, newImage(id, dest, bytes)],
        });
        added += 1;
      }
    } finally {
      if (added) this.prepare();
    }
    return added;
  }

  async removePhoto(draftId: string, imageId: string): Promise<void> {
    const draft = this.draft(draftId);
    const image = draft.images.find(i => i.id === imageId);
    if (!image) return;
    await this.deps.store.write({ ...draft, updatedAt: this.deps.clock.now(), images: draft.images.filter(i => i.id !== imageId) });
    if (image.sourcePath) await this.deps.files.remove(image.sourcePath);
    if (image.processed) await this.deps.files.remove(image.processed.path);
  }

  /**
   * Saves the report on the phone and queues it. Says nothing about the network.
   * Waits for the photo being prepared right now (if any), so the uploader never
   * works on the same photo; the rest are prepared by the uploader.
   */
  async submit(draftId: string): Promise<SubmitResult> {
    const issues = draftIssues(this.draft(draftId));
    if (issues.length) return { ok: false, issues };
    this.holding = true;
    try {
      await this.idle();
    } finally {
      this.holding = false;
    }
    const draft = this.draft(draftId);
    const after = draftIssues(draft); // the photo in hand may have turned out unusable
    if (after.length) {
      this.prepare();
      return { ok: false, issues: after };
    }
    const now = this.deps.clock.now();
    await this.deps.store.write({
      ...draft,
      description: draft.description.trim(),
      state: 'queued',
      createdAt: new Date(now).toISOString(),
      updatedAt: now,
    });
    this.deps.submitted();
    return { ok: true };
  }

  async discard(draftId: string): Promise<void> {
    await this.deps.store.discard(this.draft(draftId));
  }

  /** Pick up photos a kill left unprepared. */
  resume(): void {
    this.prepare();
  }

  /** Resolves when no photo is being prepared. */
  async idle(): Promise<void> {
    while (this.preparing) await this.preparing;
  }

  // ── Preparing photos ───────────────────────────────────────────────────────

  private prepare(): void {
    if (this.preparing) {
      this.again = true;
      return;
    }
    this.preparing = this.prepareAll().finally(() => {
      this.preparing = null;
      if (this.again && !this.holding) {
        this.again = false;
        this.prepare();
      }
    });
  }

  private async prepareAll(): Promise<void> {
    const epoch = this.deps.store.epoch;
    while (!this.holding && epoch === this.deps.store.epoch) {
      const draft = this.current();
      const index = draft?.images.findIndex(i => !i.processed && !i.problem) ?? -1;
      if (!draft || index < 0) return;
      try {
        await this.prepareOne(draft.id, draft.images[index]!, index, epoch);
      } catch (e) {
        if (e instanceof Cancelled) return;
        // A device error, not a verdict on the photo: leave it for the uploader to try again.
        this.deps.log(`[drafts] could not prepare photo ${index + 1}: ${String(e)}`);
        return;
      }
    }
  }

  private async prepareOne(reportId: string, image: LocalImage, index: number, epoch: number): Promise<void> {
    if (image.processingAttempts >= MAX_PROCESSING_ATTEMPTS) {
      await this.update(reportId, image.id, {
        problem: { code: 'photo_unreadable', message: `Photo ${index + 1} could not be processed`, imageId: image.id },
      }, epoch);
      return;
    }
    // Counted before trying, so a photo that crashes the app can't crash it forever.
    await this.update(reportId, image.id, { processingAttempts: image.processingAttempts + 1 }, epoch);
    let processed;
    try {
      processed = await processPhoto(image, { files: this.deps.files, encoder: this.deps.encoder, position: index });
    } catch (e) {
      if (e instanceof DeliveryError && e.failure.type === 'permanent') {
        await this.update(reportId, image.id, { problem: e.failure.problem }, epoch);
        return;
      }
      throw e;
    }
    const stillThere = this.deps.store.get(reportId)?.images.some(i => i.id === image.id);
    if (!stillThere || epoch !== this.deps.store.epoch) {
      // Removed (or the draft discarded) while it was being prepared.
      await this.deps.files.remove(processed.path);
      return;
    }
    await this.update(reportId, image.id, { processed, sourcePath: null, uploadedBytes: 0 }, epoch);
    if (image.sourcePath) await this.deps.files.remove(image.sourcePath);
  }

  private async update(reportId: string, imageId: string, patch: Partial<LocalImage>, epoch: number) {
    const r = this.deps.store.get(reportId);
    if (!r?.images.some(i => i.id === imageId)) return;
    await this.deps.store.write(withImage(r, imageId, patch), epoch);
  }

  private draft(id: string): LocalReport {
    const r = this.deps.store.get(id);
    if (!r || r.state !== 'draft') throw new Error(`No draft ${id}`);
    return r;
  }
}
