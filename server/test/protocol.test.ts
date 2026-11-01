import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Chaos } from '../src/chaos.js';

type Ctx = Awaited<ReturnType<typeof createApp>>;
let ctx: Ctx;
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-reports-'));
  // random() = 0 makes every rule fire deterministically.
  ctx = await createApp({ dataDir: dir, chaos: new Chaos(() => 0, () => {}), log: () => {} });
});
afterEach(async () => {
  ctx.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function jpeg(width = 64, height = 48): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#7a8894' } }).jpeg().toBuffer();
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function manifestFor(files: Buffer[], description = 'Cracked lintel, stairwell B') {
  return {
    description,
    createdAt: new Date().toISOString(),
    images: files.map(f => ({ id: randomUUID(), sha256: sha(f), size: f.length, mime: 'image/jpeg' })),
  };
}

function patch(reportId: string, imageId: string, offset: number, body: Buffer) {
  return request(ctx.app)
    .patch(`/v1/reports/${reportId}/images/${imageId}`)
    .set('Upload-Offset', String(offset))
    .set('Content-Type', 'application/offset+octet-stream')
    .send(body);
}

async function uploadAll(reportId: string, manifest: Awaited<ReturnType<typeof manifestFor>>, files: Buffer[]) {
  for (const [i, img] of manifest.images.entries()) {
    const res = await patch(reportId, img.id, 0, files[i]!);
    expect(res.status).toBe(200);
  }
}

describe('create', () => {
  it('is idempotent for the same manifest and refuses a different one', async () => {
    const id = randomUUID();
    const m = await manifestFor([await jpeg()]);
    const first = await request(ctx.app).put(`/v1/reports/${id}`).send(m);
    expect(first.status).toBe(201);
    const again = await request(ctx.app).put(`/v1/reports/${id}`).send(m);
    expect(again.status).toBe(200);
    expect(again.body.images[0].offset).toBe(0);
    const other = await request(ctx.app).put(`/v1/reports/${id}`).send({ ...m, description: 'something else' });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('manifest_conflict');
  });

  it.each([
    ['zero images', { images: [] }, 422, 'image_count'],
    ['six images', { images: 'six' }, 422, 'image_count'],
    ['blank description', { description: '   ' }, 422, 'description_required'],
    ['an image over 5,000,000 bytes', { oversize: true }, 413, 'image_too_large'],
  ])('rejects %s', async (_name, change, status, code) => {
    const files = await Promise.all(Array.from({ length: 6 }, () => jpeg()));
    const m = await manifestFor(files.slice(0, 1));
    const c = change as Record<string, unknown>;
    const body = {
      ...m,
      ...(c.description !== undefined ? { description: c.description } : {}),
      images:
        c.images === 'six' ? (await manifestFor(files)).images
        : Array.isArray(c.images) ? c.images
        : c.oversize ? [{ ...m.images[0], size: 5_000_001 }]
        : m.images,
    };
    const res = await request(ctx.app).put(`/v1/reports/${randomUUID()}`).send(body);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });
});

describe('chunked upload', () => {
  it('resumes from the server offset and rejects a wrong offset with the right one', async () => {
    const id = randomUUID();
    const file = await jpeg(400, 300);
    const m = await manifestFor([file]);
    await request(ctx.app).put(`/v1/reports/${id}`).send(m);
    const img = m.images[0]!;
    const half = Math.floor(file.length / 2);

    expect((await patch(id, img.id, 0, file.subarray(0, half))).body.offset).toBe(half);
    const head = await request(ctx.app).head(`/v1/reports/${id}/images/${img.id}`);
    expect(head.headers['upload-offset']).toBe(String(half));

    const wrong = await patch(id, img.id, 0, file.subarray(0, 10));
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ code: 'offset_mismatch', offset: half });

    expect((await patch(id, img.id, half, file.subarray(half))).body.offset).toBe(file.length);
  });

  it('refuses bytes beyond the declared size', async () => {
    const id = randomUUID();
    const file = await jpeg();
    const m = await manifestFor([file]);
    await request(ctx.app).put(`/v1/reports/${id}`).send(m);
    const res = await patch(id, m.images[0]!.id, 0, Buffer.concat([file, Buffer.alloc(10)]));
    expect(res.status).toBe(413);
  });
});

describe('commit', () => {
  it('only lists reports after commit, and commit is idempotent', async () => {
    const id = randomUUID();
    const files = [await jpeg(), await jpeg(80, 60)];
    const m = await manifestFor(files);
    await request(ctx.app).put(`/v1/reports/${id}`).send(m);

    expect((await request(ctx.app).post(`/v1/reports/${id}/commit`)).body.code).toBe('incomplete');
    await uploadAll(id, m, files);
    expect((await request(ctx.app).get('/v1/reports')).body.reports).toHaveLength(0);

    const commit = await request(ctx.app).post(`/v1/reports/${id}/commit`);
    expect(commit.status).toBe(200);
    expect(commit.body.report.images[1]).toMatchObject({ width: 80, height: 60 });
    expect((await request(ctx.app).post(`/v1/reports/${id}/commit`)).status).toBe(200);
    expect((await request(ctx.app).put(`/v1/reports/${id}`).send(m)).body.status).toBe('committed');

    const list = await request(ctx.app).get('/v1/reports');
    expect(list.body.reports).toHaveLength(1);
    expect(list.body.reports[0].description).toBe(m.description);
  });

  it('discards a corrupted image and asks for it again', async () => {
    const id = randomUUID();
    const file = await jpeg();
    const m = await manifestFor([file]);
    await request(ctx.app).put(`/v1/reports/${id}`).send(m);
    const corrupted = Buffer.from(file);
    corrupted[corrupted.length - 10] ^= 0xff;
    await patch(id, m.images[0]!.id, 0, corrupted);

    const res = await request(ctx.app).post(`/v1/reports/${id}/commit`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('checksum_mismatch');
    const head = await request(ctx.app).head(`/v1/reports/${id}/images/${m.images[0]!.id}`);
    expect(head.headers['upload-offset']).toBe('0');
  });

  it('lands exactly once when the commit reply is lost', async () => {
    const id = randomUUID();
    const files = [await jpeg()];
    const m = await manifestFor(files);
    await request(ctx.app).put(`/v1/reports/${id}`).send(m);
    await uploadAll(id, m, files);

    ctx.chaos.applyPreset('lose-next-commit');
    await expect(request(ctx.app).post(`/v1/reports/${id}/commit`)).rejects.toThrow();
    const retry = await request(ctx.app).post(`/v1/reports/${id}/commit`);
    expect(retry.status).toBe(200);
    expect((await request(ctx.app).get('/v1/reports')).body.reports).toHaveLength(1);
  });
});

describe('chaos', () => {
  it('fires one-shot errors once', async () => {
    ctx.chaos.addRule({ route: 'list', fault: { kind: 'error', status: 503 }, remaining: 1 });
    expect((await request(ctx.app).get('/v1/reports')).status).toBe(503);
    expect((await request(ctx.app).get('/v1/reports')).status).toBe(200);
  });

  it('keeps the prefix of a chunk whose connection drops mid-body', async () => {
    const id = randomUUID();
    const file = await jpeg(1200, 900);
    const m = await manifestFor([file]);
    await request(ctx.app).put(`/v1/reports/${id}`).send(m);
    ctx.chaos.addRule({ route: 'chunk', fault: { kind: 'drop', afterBytes: 1000 }, remaining: 1 });

    await expect(patch(id, m.images[0]!.id, 0, file)).rejects.toThrow();
    const head = await request(ctx.app).head(`/v1/reports/${id}/images/${m.images[0]!.id}`);
    const offset = Number(head.headers['upload-offset']);
    expect(offset).toBeLessThanOrEqual(1000);
    const rest = await patch(id, m.images[0]!.id, offset, file.subarray(offset));
    expect(rest.body.offset).toBe(file.length);
    expect((await request(ctx.app).post(`/v1/reports/${id}/commit`)).status).toBe(200);
  });

  it('refuses permanently when told to', async () => {
    ctx.chaos.applyPreset('refuse-uploads');
    const res = await request(ctx.app).put(`/v1/reports/${randomUUID()}`).send(await manifestFor([await jpeg()]));
    expect(res.status).toBe(413);
  });
});

describe('read side and reset', () => {
  it('serves thumbnails, deletes everything, and collects stale uploads', async () => {
    const id = randomUUID();
    const files = [await jpeg(800, 600)];
    const m = await manifestFor(files);
    await request(ctx.app).put(`/v1/reports/${id}`).send(m);
    await uploadAll(id, m, files);
    await request(ctx.app).post(`/v1/reports/${id}/commit`);

    const thumb = await request(ctx.app).get(`/v1/images/${m.images[0]!.id}?w=320`);
    expect(thumb.status).toBe(200);
    expect((await sharp(thumb.body).metadata()).width).toBe(320);

    const pending = randomUUID();
    await request(ctx.app).put(`/v1/reports/${pending}`).send(await manifestFor([await jpeg()]));
    await ctx.collectGarbage(Date.now() + 25 * 60 * 60 * 1000);
    expect(ctx.db.stmts.getReport.get(pending)).toBeUndefined();
    expect(ctx.db.stmts.getReport.get(id)).toBeDefined();

    expect((await request(ctx.app).delete('/v1/reports')).body.deleted).toBe(1);
    expect((await request(ctx.app).get('/v1/reports')).body.reports).toHaveLength(0);
    expect(await fs.readdir(path.join(dir, 'uploads'))).toHaveLength(0);
  });
});
