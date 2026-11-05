import express, { type ErrorRequestHandler } from 'express';
import fs from 'node:fs/promises';
import { adminRoutes } from './admin.js';
import { Chaos } from './chaos.js';
import { openDb } from './db.js';
import { PENDING_TTL_MS } from './limits.js';
import { protocolRoutes } from './routes.js';
import { Storage } from './storage.js';

export interface AppOptions {
  dataDir: string;
  chaos?: Chaos;
  log?: (msg: string) => void;
  /** When set, /admin and the chaos controls require it. */
  adminToken?: string;
}

export async function createApp({ dataDir, chaos = new Chaos(), log = console.log, adminToken }: AppOptions) {
  await fs.mkdir(dataDir, { recursive: true });
  const db = openDb(dataDir);
  const storage = new Storage(dataDir);
  await storage.init();

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`));
    next();
  });
  app.use(adminRoutes({ db, storage, chaos, adminToken }));
  app.use('/v1', protocolRoutes({ db, storage, chaos, log }));
  app.get('/', (_req, res) => res.redirect('/admin'));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    log(`[error] ${err?.stack ?? err}`);
    if (res.headersSent) return res.socket?.destroy();
    res.status(500).json({ code: 'internal', message: 'Unexpected server error' });
  };
  app.use(onError);

  /** Drops reports that started uploading but were never committed. */
  async function collectGarbage(now = Date.now()) {
    const cutoff = new Date(now - PENDING_TTL_MS).toISOString();
    for (const report of db.stmts.stalePending.all(cutoff)) {
      const imageIds = db.stmts.getImages.all(report.id).map(i => i.id);
      db.stmts.deleteReport.run(report.id);
      await storage.deleteReport(report.id, imageIds);
      log(`[gc] removed stale pending report ${report.id}`);
    }
  }

  return { app, db, storage, chaos, collectGarbage, close: () => db.close() };
}
