import type { ChunkSizer } from './chunking';
import { MAX_PROCESSING_ATTEMPTS, processPhoto } from './processing';
import type { Clock, FileStore, ImageEncoder, Logger } from './ports';
import { NetworkError } from './ports';
import type { ProtocolClient } from './protocol';
import { TIMEOUTS } from './protocol';
import { DeliveryError } from './retry';
import { LIMITS, type Activity, type LocalImage, type LocalReport } from './types';

export interface DeliveryContext {
  protocol: ProtocolClient;
  files: FileStore;
  encoder: ImageEncoder;
  clock: Clock;
  chunks: ChunkSizer;
  log: Logger;
  /** Persist and return the saved report. Throws Cancelled if the outbox was reset meanwhile. */
  save(report: LocalReport): Promise<LocalReport>;
  progress(activity: Activity | null): void;
}

/** How many times a commit may bounce back (incomplete / restart) before we call it a server problem. */
const MAX_ROUNDS = 6;
const MAX_CORRUPTIONS = 2;

/**
 * Take one report from wherever it stands to `uploaded`. Each step is persisted
 * before the next begins, so calling this again after a kill picks up where the
 * last run stopped. Throws DeliveryError (or NetworkError) on failure; the
 * caller decides about retries.
 */
export async function deliver(ctx: DeliveryContext, initial: LocalReport): Promise<LocalReport> {
  let r = initial;

  if (r.state === 'queued' || r.state === 'processing') {
    r = await processAll(ctx, await ctx.save({ ...r, state: 'processing' }));
    r = await ctx.save({ ...r, state: 'uploading' });
  }

  await preflight(ctx, r);

  let corruptions = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let result;
    try {
      if (r.state === 'uploading') {
        const manifest = await ctx.protocol.putManifest(r);
        r = await clearIssue(ctx, r);
        if (manifest.status === 'committed') return markUploaded(ctx, r);
        r = await uploadImages(ctx, r, manifest.offsets);
        r = await ctx.save({ ...r, state: 'committing' });
      }
      ctx.progress(activity(r, 'committing', r.images.length - 1));
      result = await ctx.protocol.commit(r.id);
    } catch (e) {
      // The server forgot this report (reset, or garbage-collected): send it again from the manifest.
      if (e instanceof DeliveryError && e.failure.type === 'restart') {
        ctx.log(`[deliver] ${r.id}: ${e.failure.message}; starting over`);
        r = await ctx.save({ ...r, state: 'uploading', images: r.images.map(i => ({ ...i, uploadedBytes: 0 })) });
        continue;
      }
      throw e;
    }
    if (result.kind === 'committed') return markUploaded(ctx, r);
    if (result.kind === 'corrupted') {
      corruptions += 1;
      ctx.log(`[deliver] ${r.id}: server says ${result.imageId} arrived corrupted (${corruptions})`);
      if (corruptions > MAX_CORRUPTIONS)
        throw new DeliveryError({
          type: 'permanent',
          problem: {
            code: 'corrupted_repeatedly',
            message: 'A photo keeps arriving damaged',
            imageId: result.imageId,
          },
        });
    }
    r = await ctx.save({
      ...r,
      state: 'uploading',
      images: r.images.map(i => (result.kind === 'corrupted' && i.id === result.imageId ? { ...i, uploadedBytes: 0 } : i)),
    });
  }
  throw new DeliveryError({ type: 'transient', reason: 'server', message: 'The server keeps asking for the upload again' });
}

async function processAll(ctx: DeliveryContext, report: LocalReport): Promise<LocalReport> {
  let r = report;
  for (const [index, image] of r.images.entries()) {
    if (image.processed && (await ctx.files.size(image.processed.path)) === image.processed.size) continue;
    if (image.processingAttempts >= MAX_PROCESSING_ATTEMPTS)
      throw new DeliveryError({
        type: 'permanent',
        problem: { code: 'photo_unreadable', message: `Photo ${index + 1} could not be processed`, imageId: image.id },
      });

    ctx.progress(activity(r, 'processing', index));
    r = await ctx.save(withImage(r, image.id, { processingAttempts: image.processingAttempts + 1 }));
    const processed = await processPhoto(image, { files: ctx.files, encoder: ctx.encoder, position: index });
    const sourcePath = image.sourcePath;
    r = await ctx.save(withImage(r, image.id, { processed, sourcePath: null, uploadedBytes: 0 }));
    if (sourcePath) await ctx.files.remove(sourcePath);
  }
  return r;
}

/** Last line of defence: nothing over the ceiling, and nothing whose file changed, ever goes out. */
async function preflight(ctx: DeliveryContext, r: LocalReport) {
  for (const [index, image] of r.images.entries()) {
    const p = image.processed;
    const onDisk = p ? await ctx.files.size(p.path) : null;
    if (!p || onDisk === null || onDisk !== p.size)
      throw new DeliveryError({
        type: 'permanent',
        problem: { code: 'photo_missing', message: `Photo ${index + 1} is no longer on this phone`, imageId: image.id },
      });
    if (p.size > LIMITS.maxImageBytes)
      throw new DeliveryError({
        type: 'permanent',
        problem: { code: 'too_large', message: `Photo ${index + 1} is over the 5 MB limit`, imageId: image.id },
      });
  }
}

async function uploadImages(ctx: DeliveryContext, report: LocalReport, offsets: Map<string, number>) {
  let r = report;
  for (const [index, image] of r.images.entries()) {
    const size = image.processed!.size;
    let offset = offsets.get(image.id) ?? 0;
    let resyncs = 0;
    r = await saveOffset(ctx, r, image, offset);

    while (offset < size) {
      ctx.progress(activity(r, 'uploading', index));
      const length = Math.min(ctx.chunks.current, size - offset);
      const started = ctx.clock.now();
      let result;
      try {
        result = await ctx.protocol.sendChunk(
          r.id,
          image.id,
          { path: image.processed!.path, offset, length },
          TIMEOUTS.chunkMs,
        );
      } catch (e) {
        if (e instanceof NetworkError && e.kind !== 'aborted') ctx.chunks.struggled();
        throw e;
      }
      if (result.resynced) {
        if (++resyncs > 5)
          throw new DeliveryError({ type: 'transient', reason: 'server', message: 'Upload position keeps changing' });
      } else {
        ctx.chunks.succeeded(length, ctx.clock.now() - started);
        resyncs = 0;
      }
      offset = Math.min(result.offset, size);
      r = await saveOffset(ctx, await clearIssue(ctx, r), image, offset);
    }
  }
  return r;
}

async function markUploaded(ctx: DeliveryContext, r: LocalReport): Promise<LocalReport> {
  const saved = await ctx.save(asUploaded(r, ctx.clock.now()));
  ctx.progress(null);
  await removeLocalPhotos(ctx.files, r);
  return saved;
}

/** The report as it is once the server confirmed it at `at`. */
export function asUploaded(r: LocalReport, at: number): LocalReport {
  return {
    ...r,
    state: 'uploaded',
    uploadedAt: new Date(at).toISOString(),
    attempts: 0,
    nextAttemptAt: null,
    lastIssue: null,
    problem: null,
    images: r.images.map(i => ({ ...i, uploadedBytes: i.processed?.size ?? i.uploadedBytes })),
  };
}

/** The server has the photos now; the local copies only take space. */
export async function removeLocalPhotos(files: FileStore, r: LocalReport): Promise<void> {
  for (const image of r.images) {
    if (image.processed) await files.remove(image.processed.path);
    if (image.sourcePath) await files.remove(image.sourcePath);
  }
}

/** The link works again; stop showing the last failure while bytes are moving. */
async function clearIssue(ctx: DeliveryContext, r: LocalReport): Promise<LocalReport> {
  if (!r.lastIssue && r.attempts === 0) return r;
  return ctx.save({ ...r, lastIssue: null, attempts: 0, nextAttemptAt: null });
}

async function saveOffset(ctx: DeliveryContext, r: LocalReport, image: LocalImage, offset: number) {
  const current = r.images.find(i => i.id === image.id);
  if (current?.uploadedBytes === offset) return r;
  return ctx.save(withImage(r, image.id, { uploadedBytes: offset }));
}

function withImage(r: LocalReport, imageId: string, patch: Partial<LocalImage>): LocalReport {
  return { ...r, images: r.images.map(i => (i.id === imageId ? { ...i, ...patch } : i)) };
}

function activity(r: LocalReport, stage: Activity['stage'], imageIndex: number): Activity {
  return {
    reportId: r.id,
    stage,
    imageIndex,
    imageCount: r.images.length,
    bytesSent: r.images.reduce((sum, i) => sum + i.uploadedBytes, 0),
    bytesTotal: r.images.reduce((sum, i) => sum + (i.processed?.size ?? i.sourceBytes), 0),
  };
}
