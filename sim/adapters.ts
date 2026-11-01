import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  NetworkError,
  type EncodeRequest,
  type EncodeResult,
  type FileStore,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type ImageEncoder,
  type ReportRepo,
} from '../app/src/core/ports';
import { parseReport, serializeReport } from '../app/src/core/schema';
import type { LocalReport } from '../app/src/core/types';

/** One JSON file per report, written to a temp file and renamed so each save is atomic. */
export class JsonFileRepo implements ReportRepo {
  constructor(private readonly dir: string) {}
  async load() {
    await fs.mkdir(this.dir, { recursive: true });
    const names = (await fs.readdir(this.dir)).filter(n => n.endsWith('.json'));
    return Promise.all(names.map(async n => parseReport(await fs.readFile(path.join(this.dir, n), 'utf8'))));
  }
  async save(r: LocalReport) {
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${r.id}.json`);
    await fs.writeFile(`${file}.tmp`, serializeReport(r));
    await fs.rename(`${file}.tmp`, file);
  }
  async remove(id: string) {
    await fs.rm(path.join(this.dir, `${id}.json`), { force: true });
  }
  async clear() {
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}

export class NodeFiles implements FileStore {
  constructor(readonly photosDir: string) {}
  async importPhoto(sourceUri: string, dest: string) {
    await fs.mkdir(this.photosDir, { recursive: true });
    await fs.copyFile(sourceUri, dest);
    return { bytes: (await fs.stat(dest)).size };
  }
  async size(p: string) {
    return fs.stat(p).then(s => s.size, () => null);
  }
  async move(from: string, to: string) {
    await fs.rename(from, to);
  }
  async remove(p: string) {
    await fs.rm(p, { force: true });
  }
  async sha256(p: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(p)) hash.update(chunk);
    return hash.digest('hex');
  }
  async list(dir: string) {
    return (await fs.readdir(dir).catch(() => [] as string[])).map(n => `${dir}/${n}`);
  }
  async clearAll() {
    await fs.rm(this.photosDir, { recursive: true, force: true });
  }
}

/** The phone's encoder, played by sharp: decode once, try each step, keep the first that fits. */
export class SharpEncoder implements ImageEncoder {
  async encodeToFit({ src, dest, steps, maxBytes }: EncodeRequest): Promise<EncodeResult> {
    let raw;
    try {
      raw = await sharp(src).rotate().raw().toBuffer({ resolveWithObject: true });
    } catch {
      return { kind: 'unreadable' };
    }
    const { width, height, channels } = raw.info;
    const decoded = sharp(raw.data, { raw: { width, height, channels } });
    for (const { maxEdge, quality } of steps) {
      const { data, info } = await decoded
        .clone()
        .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: false })
        .toBuffer({ resolveWithObject: true });
      if (data.length > maxBytes) continue;
      await fs.writeFile(dest, data);
      return { kind: 'ok', size: data.length, width: info.width, height: info.height };
    }
    return { kind: 'too_large' };
  }
}

/** fetch-based client with a switch that plays airplane mode. */
export class NodeHttp implements HttpClient {
  online = true;
  constructor(private readonly base: string) {}

  async send(req: HttpRequest): Promise<HttpResponse> {
    if (req.signal.aborted) throw new NetworkError('aborted', 'aborted');
    if (!this.online) throw new NetworkError('offline', 'Airplane mode');
    const timeout = AbortSignal.timeout(req.timeoutMs);
    const signal = AbortSignal.any([req.signal, timeout]);

    let body: BodyInit | undefined;
    const headers: Record<string, string> = { ...req.headers };
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['Content-Type'] = 'application/json';
    } else if (req.file) {
      const handle = await fs.open(req.file.path, 'r');
      try {
        const buf = Buffer.alloc(req.file.length);
        await handle.read(buf, 0, req.file.length, req.file.offset);
        body = buf;
      } finally {
        await handle.close();
      }
    }

    try {
      const res = await fetch(this.base + req.path, { method: req.method, headers, body, signal });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => (out[k] = v));
      return { status: res.status, headers: out, body: parsed };
    } catch (e) {
      if (req.signal.aborted) throw new NetworkError('aborted', 'aborted');
      if (timeout.aborted) throw new NetworkError('timeout', `No answer within ${req.timeoutMs} ms`);
      throw new NetworkError('offline', String((e as Error).cause ?? e));
    }
  }
}
