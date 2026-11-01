import { getServerUrl } from './settings';

/** Read side of the server, for the Sent tab. Only committed reports exist here. */

export interface ServerImage {
  id: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  thumbUrl: string;
}

export interface ServerReport {
  id: string;
  description: string;
  createdAt: string;
  committedAt: string;
  images: ServerImage[];
}

const TIMEOUT_MS = 20_000;

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(getServerUrl() + path, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`The server answered ${res.status}`);
    return res;
  } catch (e) {
    if (controller.signal.aborted) throw new Error('The server did not answer in time');
    throw e instanceof Error && e.message.startsWith('The server') ? e : new Error("Can't reach the server");
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchServerReports(): Promise<ServerReport[]> {
  const body = (await (await call('/v1/reports')).json()) as { reports: ServerReport[] };
  return body.reports;
}

export async function deleteAllServerReports(): Promise<number> {
  const body = (await (await call('/v1/reports', { method: 'DELETE' })).json()) as { deleted: number };
  return body.deleted;
}

export async function pingServer(): Promise<void> {
  await call('/v1/health');
}

export const imageUrl = (path: string) => getServerUrl() + path;
