import path from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);
const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');

const { app, collectGarbage } = await createApp({ dataDir, adminToken: process.env.ADMIN_TOKEN || undefined });

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Field Reports server on http://localhost:${port}  (admin: http://localhost:${port}/admin)`);
  console.log(`Data in ${dataDir}`);
});
// Slow 2G uploads must not be cut off by Node's defaults; stalls are the client's call.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

setInterval(() => void collectGarbage(), 60 * 60 * 1000).unref();
