import type { HttpClient, HttpRequest, HttpResponse } from './ports';
import { DeliveryError, classifyResponse } from './retry';
import type { LocalReport } from './types';

/**
 * Client for the server's resumable upload protocol:
 *
 *   PUT   /v1/reports/:id                 manifest; idempotent; answers with per-image offsets
 *   PATCH /v1/reports/:id/images/:image   raw bytes at Upload-Offset
 *   POST  /v1/reports/:id/commit          verify sha256s and publish; idempotent
 *
 * Non-success answers become DeliveryErrors, except the few 409s that are part
 * of the conversation (offset resync, incomplete, checksum), which are returned.
 */

export const TIMEOUTS = { controlMs: 30_000, chunkMs: 60_000 } as const;

type Send = Omit<HttpRequest, 'timeoutMs' | 'signal'> & { timeoutMs?: number };

export class ProtocolClient {
  constructor(
    private readonly http: HttpClient,
    private readonly signal: AbortSignal,
  ) {}

  private send(req: Send): Promise<HttpResponse> {
    return this.http.send({ timeoutMs: TIMEOUTS.controlMs, ...req, signal: this.signal });
  }

  async putManifest(
    report: LocalReport,
  ): Promise<{ status: 'pending' | 'committed'; offsets: Map<string, number> }> {
    const res = await this.send({
      method: 'PUT',
      path: `/v1/reports/${report.id}`,
      json: {
        description: report.description,
        createdAt: report.createdAt,
        images: report.images.map(img => {
          if (!img.processed) throw new Error(`Image ${img.id} is not processed`);
          return { id: img.id, sha256: img.processed.sha256, size: img.processed.size, mime: 'image/jpeg' };
        }),
      },
    });
    if (res.status !== 200 && res.status !== 201) throw new DeliveryError(classifyResponse(res.status, res.body, res.headers));
    const body = res.body as { status: 'pending' | 'committed'; images: { id: string; offset: number }[] };
    return { status: body.status, offsets: new Map(body.images.map(i => [i.id, i.offset])) };
  }

  /** Returns the offset the server now holds for the image. */
  async sendChunk(
    reportId: string,
    imageId: string,
    file: { path: string; offset: number; length: number },
    timeoutMs: number,
  ): Promise<{ offset: number; resynced: boolean }> {
    const res = await this.send({
      method: 'PATCH',
      path: `/v1/reports/${reportId}/images/${imageId}`,
      headers: { 'Upload-Offset': String(file.offset), 'Content-Type': 'application/offset+octet-stream' },
      file,
      timeoutMs,
    });
    const body = res.body as { offset?: number; code?: string } | null;
    if (res.status === 200 && typeof body?.offset === 'number') return { offset: body.offset, resynced: false };
    if (res.status === 409 && body?.code === 'offset_mismatch' && typeof body.offset === 'number')
      return { offset: body.offset, resynced: true };
    if (res.status === 409 && body?.code === 'already_committed') return { offset: file.offset + file.length, resynced: true };
    throw new DeliveryError(classifyResponse(res.status, res.body, res.headers));
  }

  async commit(
    reportId: string,
  ): Promise<{ kind: 'committed' } | { kind: 'incomplete' } | { kind: 'corrupted'; imageId: string }> {
    const res = await this.send({ method: 'POST', path: `/v1/reports/${reportId}/commit` });
    const body = res.body as { code?: string; imageId?: string } | null;
    if (res.status === 200) return { kind: 'committed' };
    if (res.status === 409 && body?.code === 'incomplete') return { kind: 'incomplete' };
    if (res.status === 409 && body?.code === 'checksum_mismatch' && body.imageId)
      return { kind: 'corrupted', imageId: body.imageId };
    throw new DeliveryError(classifyResponse(res.status, res.body, res.headers));
  }
}
