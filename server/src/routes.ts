import express, { Router, type Request, type Response } from 'express';
import { createWriteStream, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import type { Chaos, ChaosLocals } from './chaos.js';
import type { Db, ImageRow, ReportRow } from './db.js';
import type { Storage } from './storage.js';
import { throttle } from './throttle.js';
import { isId, manifestHash, validateManifest } from './validation.js';

const THUMB_WIDTHS = new Set([160, 320, 640, 1280]);

interface Deps {
  db: Db;
  storage: Storage;
  chaos: Chaos;
  log: (msg: string) => void;
}

const error = (res: Response, status: number, code: string, message: string, extra: object = {}) =>
  res.status(status).json({ code, message, ...extra });

export function reportDto(report: ReportRow, images: ImageRow[]) {
  return {
    id: report.id,
    description: report.description,
    createdAt: report.created_at,
    committedAt: report.committed_at,
    images: images.map(i => ({
      id: i.id,
      size: i.size,
      width: i.width,
      height: i.height,
      url: `/v1/images/${i.id}`,
      thumbUrl: `/v1/images/${i.id}?w=320`,
    })),
  };
}

export function protocolRoutes({ db, storage, chaos, log }: Deps): Router {
  const r = Router();
  /** One writer per image: a timed-out request can still be streaming when the retry arrives. */
  const writing = new Set<string>();

  r.get('/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // ── Create (idempotent) ────────────────────────────────────────────────────
  r.put('/reports/:id', chaos.gate('manifest'), express.json({ limit: '64kb' }), async (req, res) => {
    const id = req.params.id as string;
    if (!isId(id)) return error(res, 400, 'invalid_report_id', 'Report id must be a UUID');
    const v = validateManifest(req.body);
    if (!v.ok) return error(res, v.status, v.code, v.message);
    const hash = manifestHash(v.manifest);

    const existing = db.stmts.getReport.get(id);
    if (existing) {
      if (existing.manifest_hash !== hash)
        return error(res, 409, 'manifest_conflict', 'A different report already uses this id');
      return res.status(200).json(await uploadState(existing));
    }

    try {
      db.createReport(
        {
          id,
          description: v.manifest.description,
          created_at: v.manifest.createdAt,
          received_at: new Date().toISOString(),
          manifest_hash: hash,
        },
        v.manifest.images.map((img, idx) => ({ ...img, report_id: id, idx })),
      );
    } catch (e) {
      if (String(e).includes('UNIQUE')) return error(res, 409, 'image_id_conflict', 'An image id is already in use');
      throw e;
    }
    await storage.ensureReportDir(id);
    log(`[report] ${id} created with ${v.manifest.images.length} image(s)`);
    res.status(201).json(await uploadState(db.stmts.getReport.get(id)!));
  });

  // ── Where to resume ────────────────────────────────────────────────────────
  r.head('/reports/:id/images/:imageId', chaos.gate('offset'), async (req, res) => {
    const image = findImage(req);
    if (!image) return res.status(404).end();
    res
      .set('Upload-Offset', String(await storage.offset(image.report_id, image.id)))
      .set('Upload-Length', String(image.size))
      .set('Cache-Control', 'no-store')
      .status(200)
      .end();
  });

  // ── Append a chunk ─────────────────────────────────────────────────────────
  r.patch('/reports/:id/images/:imageId', chaos.gate('chunk'), async (req, res) => {
    const image = findImage(req);
    if (!image) return error(res, 404, 'not_found', 'Unknown report or image');
    const report = db.stmts.getReport.get(image.report_id)!;
    if (report.status === 'committed') return error(res, 409, 'already_committed', 'Report is already committed');

    const claimed = Number(req.get('Upload-Offset'));
    if (!Number.isInteger(claimed) || claimed < 0) return error(res, 400, 'invalid_offset', 'Upload-Offset required');

    if (writing.has(image.id)) {
      res.set('Retry-After', '2');
      return error(res, 423, 'busy', 'Another upload for this image is still in progress');
    }
    writing.add(image.id);
    try {
      const current = await storage.offset(image.report_id, image.id);
      if (claimed !== current) return error(res, 409, 'offset_mismatch', 'Resume from the returned offset', { offset: current });

      const declared = Number(req.get('Content-Length') ?? NaN);
      if (Number.isFinite(declared) && current + declared > image.size)
        return error(res, 413, 'chunk_overflows_image', 'Chunk would make the image larger than declared');

      const dropAfter = (res.locals as ChaosLocals).dropAfterBytes;
      let received = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, done) {
          received += chunk.length;
          if (current + received > image.size) return done(new OverflowError());
          if (dropAfter !== undefined && received >= dropAfter) {
            done(null, chunk.subarray(0, chunk.length - (received - dropAfter)));
            log(`[chaos] dropping chunk connection after ${dropAfter} B`);
            req.socket.destroy();
            return;
          }
          done(null, chunk);
        },
      });

      try {
        await pipeline(
          req,
          throttle(() => chaos.bandwidth()),
          guard,
          createWriteStream(storage.imagePath(image.report_id, image.id), { flags: 'a' }),
        );
      } catch (e) {
        if (e instanceof OverflowError) {
          await fs.truncate(storage.imagePath(image.report_id, image.id), current);
          return error(res, 413, 'chunk_overflows_image', 'Received more bytes than the image declares');
        }
        // Client went away (or chaos dropped it). Whatever bytes landed are a valid prefix.
        log(`[chunk] ${image.id} interrupted at +${received} B`);
        return;
      }

      const offset = await storage.offset(image.report_id, image.id);
      res.set('Upload-Offset', String(offset)).json({ offset, size: image.size });
    } finally {
      writing.delete(image.id);
    }
  });

  // ── Commit (idempotent) ────────────────────────────────────────────────────
  r.post('/reports/:id/commit', chaos.gate('commit'), async (req, res) => {
    const id = req.params.id as string;
    const report = isId(id) ? db.stmts.getReport.get(id) : undefined;
    if (!report) return error(res, 404, 'not_found', 'Unknown report');
    const images = db.stmts.getImages.all(id);
    if (report.status === 'committed') return res.json({ status: 'committed', report: reportDto(report, images) });

    const state = await uploadState(report);
    const incomplete = state.images.filter(i => i.offset !== i.size);
    if (incomplete.length) return error(res, 409, 'incomplete', 'Some images are not fully uploaded', state);

    for (const image of images) {
      const actual = await storage.sha256(id, image.id);
      if (actual !== image.sha256) {
        await storage.discardImage(id, image.id);
        log(`[commit] ${id} image ${image.id} checksum mismatch, discarded`);
        return error(res, 409, 'checksum_mismatch', 'Image arrived corrupted; upload it again from 0', {
          imageId: image.id,
        });
      }
      try {
        const meta = await sharp(storage.imagePath(id, image.id)).metadata();
        db.stmts.setDims.run(meta.width ?? null, meta.height ?? null, image.id);
      } catch {
        return error(res, 422, 'not_an_image', `Image ${image.id} is not a decodable JPEG`);
      }
    }

    db.stmts.commit.run(new Date().toISOString(), id);
    log(`[commit] ${id} committed`);
    const committed = db.stmts.getReport.get(id)!;
    res.json({ status: 'committed', report: reportDto(committed, db.stmts.getImages.all(id)) });
  });

  // ── Read side: only committed reports exist as far as the app is concerned ──
  r.get('/reports', chaos.gate('list'), (_req, res) => {
    const reports = db.stmts.listCommitted.all().map(rep => reportDto(rep, db.stmts.getImages.all(rep.id)));
    res.set('Cache-Control', 'no-store').json({ reports, serverTime: new Date().toISOString() });
  });

  r.get('/reports/:id', chaos.gate('list'), (req, res) => {
    const id = req.params.id as string;
    const report = isId(id) ? db.stmts.getReport.get(id) : undefined;
    if (!report || report.status !== 'committed') return error(res, 404, 'not_found', 'No such report on the server');
    res.json(reportDto(report, db.stmts.getImages.all(id)));
  });

  r.get('/images/:imageId', chaos.gate('image'), async (req, res) => {
    const imageId = req.params.imageId as string;
    const image = isId(imageId) ? db.stmts.getImage.get(imageId) : undefined;
    const report = image && db.stmts.getReport.get(image.report_id);
    if (!image || report?.status !== 'committed') return error(res, 404, 'not_found', 'No such image');

    let file = storage.imagePath(image.report_id, image.id);
    const w = Number(req.query.w);
    if (THUMB_WIDTHS.has(w)) {
      const thumb = storage.thumbPath(image.id, w);
      const exists = await fs.stat(thumb).then(() => true, () => false);
      if (!exists) await sharp(file).resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 75 }).toFile(thumb);
      file = thumb;
    }
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Content-Length', String((await fs.stat(file)).size));
    await pipeline(createReadStream(file), throttle(() => chaos.bandwidth()), res).catch(() => {});
  });

  // ── Reset ──────────────────────────────────────────────────────────────────
  r.delete('/reports', chaos.gate('reset'), async (_req, res) => {
    const count = db.stmts.listAll.all().length;
    db.stmts.deleteAll.run();
    await storage.deleteEverything();
    log(`[reset] deleted ${count} report(s) and all files`);
    res.json({ deleted: count });
  });

  return r;

  function findImage(req: Request): ImageRow | undefined {
    const { id, imageId } = req.params as { id: string; imageId: string };
    if (!isId(id) || !isId(imageId)) return undefined;
    const image = db.stmts.getImage.get(imageId);
    return image?.report_id === id ? image : undefined;
  }

  async function uploadState(report: ReportRow) {
    const images = db.stmts.getImages.all(report.id);
    return {
      id: report.id,
      status: report.status,
      images: await Promise.all(
        images.map(async i => ({ id: i.id, size: i.size, offset: await storage.offset(report.id, i.id) })),
      ),
    };
  }
}

class OverflowError extends Error {}
