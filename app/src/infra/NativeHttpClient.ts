import ReactNativeBlobUtil from 'react-native-blob-util';
import { NetworkError, type HttpClient, type HttpRequest, type HttpResponse } from '../core/ports';
import { DIRS, ensureDir } from './BlobFileStore';

const { fs } = ReactNativeBlobUtil;

const parse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
};

const lower = (headers: Record<string, string> | undefined) =>
  Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));

/**
 * Control requests go through fetch. Photo bytes go through blob-util, which
 * streams a file from disk as a raw body: no base64, no copy of the photo in
 * JS memory. A chunk is cut into its own small file first.
 */
export class NativeHttpClient implements HttpClient {
  constructor(private readonly baseUrl: () => string) {}

  send(req: HttpRequest): Promise<HttpResponse> {
    return req.file ? this.sendFile(req) : this.sendJson(req);
  }

  private async sendJson(req: HttpRequest): Promise<HttpResponse> {
    if (req.signal.aborted) throw new NetworkError('aborted', 'aborted');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs);
    const onAbort = () => controller.abort();
    req.signal.addEventListener('abort', onAbort);
    try {
      const res = await fetch(this.baseUrl() + req.path, {
        method: req.method,
        headers: { ...(req.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...req.headers },
        body: req.json !== undefined ? JSON.stringify(req.json) : undefined,
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      return { status: res.status, headers, body: parse(await res.text()) };
    } catch (e) {
      if (req.signal.aborted) throw new NetworkError('aborted', 'aborted');
      if (timedOut) throw new NetworkError('timeout', `No answer within ${req.timeoutMs / 1000} s`);
      throw new NetworkError('offline', String(e));
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
    }
  }

  private async sendFile(req: HttpRequest): Promise<HttpResponse> {
    const { path, offset, length } = req.file!;
    await ensureDir(DIRS.chunks);
    const chunk = `${DIRS.chunks}/${Date.now()}-${offset}.part`;
    await fs.slice(path, chunk, offset, offset + length);

    let timedOut = false;
    const task = ReactNativeBlobUtil.config({ timeout: req.timeoutMs }).fetch(
      req.method,
      this.baseUrl() + req.path,
      req.headers ?? {},
      ReactNativeBlobUtil.wrap(chunk),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      task.cancel();
    }, req.timeoutMs);
    const onAbort = () => task.cancel();
    req.signal.addEventListener('abort', onAbort);
    try {
      const res = await task;
      const info = res.info();
      return { status: info.status, headers: lower(info.headers), body: parse(res.text() as string) };
    } catch (e) {
      if (req.signal.aborted) throw new NetworkError('aborted', 'aborted');
      if (timedOut || /timed? ?out/i.test(String(e))) throw new NetworkError('timeout', `No answer within ${req.timeoutMs / 1000} s`);
      throw new NetworkError('offline', String(e));
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
      fs.unlink(chunk).catch(() => {});
    }
  }
}
