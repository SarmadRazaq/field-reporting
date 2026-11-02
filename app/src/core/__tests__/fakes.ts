import { createHash, randomUUID } from 'crypto';
import {
  NetworkError,
  type Clock,
  type EncodeRequest,
  type EncodeResult,
  type EncodeStep,
  type FileStore,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type ImageEncoder,
  type ReportRepo,
} from '../ports';
import { Outbox } from '../outbox';
import { parseReport, serializeReport } from '../schema';
import type { LocalReport } from '../types';

export const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Repo that round-trips through the stored form, like the real one, so shared references can't hide bugs. */
export class MemoryRepo implements ReportRepo {
  rows = new Map<string, string>();
  async load() {
    return [...this.rows.values()].map(parseReport);
  }
  async save(r: LocalReport) {
    this.rows.set(r.id, serializeReport(r));
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
  async clear() {
    this.rows.clear();
  }
}

export class MemoryFiles implements FileStore {
  readonly photosDir = '/app/photos';
  files = new Map<string, Uint8Array>();
  /** What the picker can hand us. */
  gallery = new Map<string, Uint8Array>();
  async importPhoto(uri: string, dest: string) {
    const bytes = this.gallery.get(uri);
    if (!bytes) throw new Error(`no such picked file ${uri}`);
    this.files.set(dest, bytes.slice());
    return { bytes: bytes.length };
  }
  async size(path: string) {
    return this.files.get(path)?.length ?? null;
  }
  async move(from: string, to: string) {
    const b = this.files.get(from);
    if (!b) throw new Error(`missing ${from}`);
    this.files.set(to, b);
    this.files.delete(from);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async sha256(path: string) {
    return sha(this.files.get(path)!);
  }
  async list(dir: string) {
    return [...this.files.keys()].filter(p => p.startsWith(`${dir}/`));
  }
  async clearAll() {
    this.files.clear();
  }
  read(path: string, offset: number, length: number) {
    return this.files.get(path)!.subarray(offset, offset + length);
  }
}

type StepCall = EncodeStep & { src: string };

/** Pretends to encode: output size shrinks with edge and quality. Records each step it tries. */
export class FakeEncoder implements ImageEncoder {
  calls: StepCall[] = [];
  /** Set to make encodes for a source never finish (simulates a kill mid-processing). */
  hangOn = new Set<string>();
  /** Every encode hangs, whatever the source. */
  hangAll = false;
  /** Steps with a long edge above this fail to decode, like running out of memory. */
  failAboveEdge = Infinity;
  sizeFor = (sourceBytes: number, step: EncodeStep) =>
    Math.round(sourceBytes * (step.maxEdge / 6000) ** 2 * (step.quality / 100) * 0.5);
  constructor(private readonly files: MemoryFiles) {}
  async encodeToFit(req: EncodeRequest): Promise<EncodeResult> {
    if (this.hangAll || this.hangOn.has(req.src)) await new Promise(() => {});
    const src = this.files.files.get(req.src);
    let decoded = false;
    for (const step of req.steps) {
      this.calls.push({ src: req.src, ...step });
      if (!src || step.maxEdge > this.failAboveEdge) continue;
      decoded = true;
      const size = Math.max(1, this.sizeFor(src.length, step));
      if (size > req.maxBytes) continue;
      const out = new Uint8Array(size);
      for (let i = 0; i < size; i++) out[i] = (i * 31 + src[i % src.length]!) & 0xff;
      this.files.files.set(req.dest, out);
      return { kind: 'ok', size, width: step.maxEdge, height: Math.round(step.maxEdge * 0.75) };
    }
    return { kind: decoded ? 'too_large' : 'unreadable' };
  }
}

export type Route = 'manifest' | 'chunk' | 'commit' | 'list';
export type Fault =
  | { kind: 'status'; status: number; headers?: Record<string, string> }
  | { kind: 'offline' }
  /** The request never gets an answer; the client's timeout fires. */
  | { kind: 'timeout' }
  /** The connection dies after `afterBytes` of a chunk made it. */
  | { kind: 'drop'; afterBytes: number }
  /** Do the work, lose the reply. */
  | { kind: 'lose-response' }
  /** Flip bytes in the stored chunk (corruption in transit). */
  | { kind: 'corrupt' }
  /** Never answer and never time out: a killed process's last request. */
  | { kind: 'freeze' }
  /** Arrives, then waits for the test to call release(); the server does the work only then. */
  | { kind: 'hold' };

interface ServerImage {
  id: string;
  sha256: string;
  size: number;
  bytes: Uint8Array;
}
interface ServerReport {
  id: string;
  description: string;
  createdAt: string;
  status: 'pending' | 'committed';
  images: ServerImage[];
  manifestKey: string;
  commits: number;
}

/** An in-memory model of the real server's protocol, with fault injection. */
export class FakeServer implements HttpClient {
  reports = new Map<string, ServerReport>();
  requests: { method: string; path: string; route: Route }[] = [];
  private faults: { route: Route | 'any'; fault: Fault; times: number }[] = [];
  /** When set, every request fails as if there were no network. */
  offline = false;

  constructor(private readonly files: MemoryFiles) {}

  inject(route: Route | 'any', fault: Fault, times = 1) {
    this.faults.push({ route, fault, times });
  }

  clearFaults() {
    this.faults = [];
  }

  committed() {
    return [...this.reports.values()].filter(r => r.status === 'committed');
  }

  private takeFault(route: Route): Fault | undefined {
    const f = this.faults.find(x => x.route === route || x.route === 'any');
    if (!f) return undefined;
    f.times -= 1;
    if (f.times <= 0) this.faults.splice(this.faults.indexOf(f), 1);
    return f.fault;
  }

  private held: (() => void)[] = [];

  /** Let every held request through. */
  release() {
    for (const resolve of this.held.splice(0)) resolve();
  }

  /** How many requests are being held right now. */
  holding() {
    return this.held.length;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    if (req.signal.aborted) throw new NetworkError('aborted', 'aborted');
    const route: Route =
      req.method === 'PUT' ? 'manifest' : req.method === 'PATCH' ? 'chunk' : req.method === 'POST' ? 'commit' : 'list';
    this.requests.push({ method: req.method, path: req.path, route });
    await Promise.resolve();
    if (this.offline) throw new NetworkError('offline', 'Network request failed');

    const fault = this.takeFault(route);
    if (fault?.kind === 'offline') throw new NetworkError('offline', 'Network request failed');
    if (fault?.kind === 'timeout') throw new NetworkError('timeout', 'timed out');
    if (fault?.kind === 'hold') {
      await new Promise<void>(resolve => this.held.push(resolve));
      if (req.signal.aborted) throw new NetworkError('aborted', 'aborted');
    }
    if (fault?.kind === 'freeze')
      return new Promise((_, reject) =>
        req.signal.addEventListener('abort', () => reject(new NetworkError('aborted', 'aborted'))),
      );
    if (fault?.kind === 'status') return { status: fault.status, headers: fault.headers ?? {}, body: { code: 'injected' } };

    const res = this.handle(req, fault);
    if (fault?.kind === 'lose-response') throw new NetworkError('offline', 'connection reset');
    if (fault?.kind === 'drop') throw new NetworkError('offline', 'connection reset');
    return res;
  }

  private handle(req: HttpRequest, fault: Fault | undefined): HttpResponse {
    const ok = (body: unknown, status = 200): HttpResponse => ({ status, headers: {}, body });
    const err = (status: number, code: string, extra: object = {}): HttpResponse => ({
      status,
      headers: {},
      body: { code, message: code, ...extra },
    });
    const [, , , id, , imageId, action] = req.path.split('/');
    const report = this.reports.get(id!);

    if (req.method === 'PUT') {
      const m = req.json as { description: string; createdAt: string; images: { id: string; sha256: string; size: number }[] };
      if (m.images.length < 1 || m.images.length > 5) return err(422, 'image_count');
      if (m.images.some(i => i.size > 5_000_000)) return err(413, 'image_too_large');
      const key = JSON.stringify(m);
      if (report) {
        if (report.manifestKey !== key) return err(409, 'manifest_conflict');
      } else {
        this.reports.set(id!, {
          id: id!,
          description: m.description,
          createdAt: m.createdAt,
          status: 'pending',
          manifestKey: key,
          commits: 0,
          images: m.images.map(i => ({ ...i, bytes: new Uint8Array(0) })),
        });
      }
      const r = this.reports.get(id!)!;
      return ok({ status: r.status, images: r.images.map(i => ({ id: i.id, offset: i.bytes.length })) }, report ? 200 : 201);
    }

    if (!report) return err(404, 'not_found');

    if (req.method === 'PATCH') {
      const image = report.images.find(i => i.id === imageId);
      if (!image) return err(404, 'not_found');
      if (report.status === 'committed') return err(409, 'already_committed');
      const claimed = Number(req.headers?.['Upload-Offset']);
      if (claimed !== image.bytes.length) return err(409, 'offset_mismatch', { offset: image.bytes.length });
      let chunk = this.files.read(req.file!.path, req.file!.offset, req.file!.length).slice();
      if (fault?.kind === 'drop') chunk = chunk.subarray(0, Math.min(fault.afterBytes, chunk.length));
      if (fault?.kind === 'corrupt' && chunk.length) chunk[0] = chunk[0]! ^ 0xff;
      if (image.bytes.length + chunk.length > image.size) return err(413, 'chunk_overflows_image');
      const next = new Uint8Array(image.bytes.length + chunk.length);
      next.set(image.bytes);
      next.set(chunk, image.bytes.length);
      image.bytes = next;
      return ok({ offset: image.bytes.length, size: image.size });
    }

    if (req.method === 'POST' && action === undefined) {
      if (report.status === 'committed') return ok({ status: 'committed' });
      if (report.images.some(i => i.bytes.length !== i.size)) return err(409, 'incomplete');
      const bad = report.images.find(i => sha(i.bytes) !== i.sha256);
      if (bad) {
        bad.bytes = new Uint8Array(0);
        return err(409, 'checksum_mismatch', { imageId: bad.id });
      }
      report.status = 'committed';
      report.commits += 1;
      return ok({ status: 'committed' });
    }
    return err(404, 'not_found');
  }
}

export class FakeClock implements Clock {
  t = Date.parse('2026-11-01T09:00:00Z');
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(id: unknown) {
    this.timers = this.timers.filter(t => t.id !== id);
  }
  pendingTimers() {
    return this.timers.length;
  }
  /** Jump to the next timer and fire it. */
  fireNext(): boolean {
    this.timers.sort((a, b) => a.at - b.at);
    const next = this.timers.shift();
    if (!next) return false;
    this.t = Math.max(this.t, next.at);
    next.fn();
    return true;
  }
}

export interface World {
  repo: MemoryRepo;
  files: MemoryFiles;
  encoder: FakeEncoder;
  server: FakeServer;
  clock: FakeClock;
  outbox: Outbox;
  logs: string[];
  /** A new Outbox over the same disk and server: what the app sees after a force-quit. */
  relaunch(): Promise<Outbox>;
}

export async function world(): Promise<World> {
  const repo = new MemoryRepo();
  const files = new MemoryFiles();
  const encoder = new FakeEncoder(files);
  const server = new FakeServer(files);
  const clock = new FakeClock();
  const logs: string[] = [];
  const make = () =>
    new Outbox({ repo, files, encoder, http: server, clock, newId: randomUUID, random: () => 0.5, log: m => logs.push(m) });
  const w: World = {
    repo,
    files,
    encoder,
    server,
    clock,
    logs,
    outbox: make(),
    async relaunch() {
      w.outbox = make();
      await w.outbox.start();
      return w.outbox;
    },
  };
  await w.outbox.start();
  return w;
}

let photoSeq = 0;
/** Put photos in the fake gallery and compose + submit a report with them. */
export async function fileReport(w: World, photoBytes: number[], description = 'Water ingress, level 2 plant room') {
  const uris = photoBytes.map(size => {
    const uri = `content://media/photo-${++photoSeq}`;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 4096) bytes[i] = (i / 4096 + photoSeq) & 0xff;
    w.files.gallery.set(uri, bytes);
    return uri;
  });
  const draft = await w.outbox.drafts.start();
  await w.outbox.drafts.setDescription(draft.id, description);
  await w.outbox.drafts.addPhotos(draft.id, uris);
  const result = await w.outbox.drafts.submit(draft.id);
  if (!result.ok) throw new Error(`submit failed: ${result.issues.join(',')}`);
  return draft.id;
}

/** Let the outbox run, firing backoff timers, until nothing is left to do. */
export async function settle(w: World, maxTimers = 200) {
  await flush();
  await w.outbox.idle();
  for (let i = 0; i < maxTimers && w.clock.fireNext(); i++) {
    await flush();
    await w.outbox.idle();
  }
}

export const flush = () => new Promise<void>(r => setImmediate(() => r()));

export const MB = 1_000_000;
