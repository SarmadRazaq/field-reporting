import type { LocalReport } from './types';

/**
 * Everything the core needs from the outside world. React Native implements
 * these in src/infra; tests and the Node simulation implement them in memory
 * or with Node APIs.
 */

/** Durable storage for reports. Each save must be atomic. */
export interface ReportRepo {
  load(): Promise<LocalReport[]>;
  save(report: LocalReport): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface FileStore {
  /** Directory the app owns for photos. */
  readonly photosDir: string;
  /** Copy a picked photo (file:// or content://) into `dest`. */
  importPhoto(sourceUri: string, dest: string): Promise<{ bytes: number }>;
  /** Size in bytes, or null if missing. */
  size(path: string): Promise<number | null>;
  /** Rename, replacing `to` if it exists. */
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  sha256(path: string): Promise<string>;
  /** Full paths of the files in a directory. */
  list(dir: string): Promise<string[]>;
  /** Delete every file the app has written: photos, caches, temp chunks. */
  clearAll(): Promise<void>;
}

export interface EncodeStep {
  /** Longest edge in pixels; never scaled up. */
  maxEdge: number;
  /** 0–100 */
  quality: number;
}

export interface EncodeRequest {
  src: string;
  dest: string;
  /** Tried in order; the first JPEG of at most `maxBytes` wins. */
  steps: readonly EncodeStep[];
  maxBytes: number;
}

export type EncodeResult =
  | { kind: 'ok'; size: number; width: number; height: number }
  /** No step could decode the photo (corrupt, unsupported format, out of memory at every size). */
  | { kind: 'unreadable' }
  /** It decoded, but even the last step came out over `maxBytes`. */
  | { kind: 'too_large' };

export interface ImageEncoder {
  /**
   * Decode the photo (applying its orientation), then try each step until a
   * JPEG fits, and write that one to `dest`. The policy (steps, limit) comes
   * from the core; how few times the photo is decoded is up to the encoder.
   */
  encodeToFit(req: EncodeRequest): Promise<EncodeResult>;
}

export type HttpMethod = 'GET' | 'HEAD' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  /** Relative to the server base URL, e.g. /v1/reports/abc */
  path: string;
  headers?: Record<string, string>;
  json?: unknown;
  /** Send this byte range of a local file as the raw body. */
  file?: { path: string; offset: number; length: number };
  timeoutMs: number;
  signal: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: unknown;
}

/** Thrown by HttpClient when no HTTP response arrived. */
export class NetworkError extends Error {
  constructor(
    readonly kind: 'offline' | 'timeout' | 'aborted',
    message: string,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface HttpClient {
  send(req: HttpRequest): Promise<HttpResponse>;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Remembers when the server last answered, across launches. */
export interface ContactStore {
  get(): number | null;
  set(at: number): void;
}

export interface Logger {
  (message: string): void;
}
