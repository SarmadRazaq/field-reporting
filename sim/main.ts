/**
 * The brief's main scenario, scripted, against the real server:
 *
 *   airplane mode on → compose three reports (one with five huge photos)
 *   → force-quit → reopen → throttled, flaky link, dropped twice mid-upload,
 *   plus a lost commit reply and another force-quit
 *   → expect all three on the server, exactly once, every image intact and under the cap.
 *
 *   npm run sim                         (server must be running on :4000)
 *   SERVER=http://host:4000 npm run sim
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Outbox } from '../app/src/core/outbox';
import { summarize } from '../app/src/core/status';
import { LIMITS } from '../app/src/core/types';
import { JsonFileRepo, NodeFiles, NodeHttp, SharpEncoder } from './adapters';

const SERVER = process.env.SERVER ?? 'http://localhost:4000';
const BANDWIDTH = Number(process.env.BANDWIDTH ?? 150_000); // bytes/s; real 2G is ~6 KB/s, which would take an hour
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'field-reports-sim-'));
const disk = { repo: path.join(work, 'db'), photos: path.join(work, 'photos'), camera: path.join(work, 'camera') };

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`;
const say = (msg: string) => console.log(`${t()}  ${msg}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function admin(method: string, p: string, body?: unknown) {
  const res = await fetch(SERVER + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}`);
  return res.json();
}

/** A "camera original": 6000×4500 with texture, saved at q95. Typically 10–20 MB. */
async function cameraPhoto(i: number): Promise<string> {
  await fs.mkdir(disk.camera, { recursive: true });
  const file = path.join(disk.camera, `IMG_${1000 + i}.jpg`);
  const width = 6000;
  const height = 4500;
  const gradient = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="hsl(${i * 47},45%,55%)"/><stop offset="1" stop-color="hsl(${i * 47 + 120},35%,30%)"/>
      </linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>
      <text x="300" y="900" font-size="600" fill="white" font-family="sans-serif">PHOTO ${i}</text></svg>`,
  );
  const noise = await sharp({
    create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 28 } },
  })
    .png()
    .toBuffer();
  await sharp(gradient).composite([{ input: noise, blend: 'overlay' }]).jpeg({ quality: 95 }).toFile(file);
  return file;
}

function makeOutbox(http: NodeHttp) {
  return new Outbox({
    repo: new JsonFileRepo(disk.repo),
    files: new NodeFiles(disk.photos),
    encoder: new SharpEncoder(),
    http,
    newId: randomUUID,
    log: m => (process.env.VERBOSE ? say(m) : undefined),
  });
}

function watch(outbox: Outbox) {
  let last = '';
  return outbox.subscribe(() => {
    const s = summarize(outbox.getSnapshot(), Date.now());
    const line = s.text;
    if (line !== last) say(`  ⟶ ${line}`);
    last = line;
  });
}

async function main() {
  say(`Server ${SERVER}; scratch dir ${work}`);
  await admin('GET', '/v1/health');
  await admin('DELETE', '/v1/reports');
  await admin('DELETE', '/__chaos');

  say('Taking photos (camera originals)…');
  const photos = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(cameraPhoto));
  for (const p of photos) say(`  ${path.basename(p)}  ${((await fs.stat(p)).size / 1e6).toFixed(1)} MB`);

  // ── 1. Airplane mode, compose three reports ────────────────────────────────
  const http = new NodeHttp(SERVER);
  http.online = false;
  let outbox = makeOutbox(http);
  await outbox.start();
  let unwatch = watch(outbox);
  say('Airplane mode ON. Composing three reports.');
  const plan: [string, string[]][] = [
    ['Cracked lintel above stairwell B door', photos.slice(0, 5)],
    ['Standing water, plant room level 2', photos.slice(5, 6)],
    ['Fire door 3F does not self-close', photos.slice(6, 7)],
  ];
  const ids: string[] = [];
  for (const [description, files] of plan) {
    const draft = await outbox.drafts.start();
    await outbox.drafts.setDescription(draft.id, description);
    await outbox.drafts.addPhotos(draft.id, files);
    const result = await outbox.drafts.submit(draft.id);
    if (!result.ok) throw new Error(result.issues.join());
    ids.push(draft.id);
  }
  await sleep(4_000); // let it try, fail, and back off

  // ── 2. Force-quit and reopen ───────────────────────────────────────────────
  say('Force-quit.');
  unwatch();
  await outbox.stop();
  await fs.rm(disk.camera, { recursive: true, force: true }); // the originals are gone; our copies must not be
  outbox = makeOutbox(http);
  await outbox.start();
  unwatch = watch(outbox);
  say(`Reopened: ${outbox.getSnapshot().reports.length} reports found on disk.`);

  // ── 3. Throttled, flaky link ───────────────────────────────────────────────
  await admin('PUT', '/__chaos', { latencyMs: 300, bandwidthBytesPerSec: BANDWIDTH });
  await admin('POST', '/__chaos/rules', { route: 'chunk', fault: { kind: 'drop', afterBytes: 20_000 }, rate: 0.15 });
  await admin('POST', '/__chaos/rules', { route: 'any', fault: { kind: 'error', status: 503 }, rate: 0.05 });
  await admin('POST', '/__chaos/rules', { route: 'commit', fault: { kind: 'lose-response' }, remaining: 1 });
  say(`Airplane mode OFF. Link throttled to ${(BANDWIDTH / 1000).toFixed(0)} KB/s, 300 ms latency, 15% chunk drops, 5% 503s, one lost commit reply.`);
  http.online = true;
  outbox.connectivityChanged(true);

  const until = async (cond: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await sleep(200);
  };
  const uploading = () => outbox.getSnapshot().activity?.stage === 'uploading';

  for (const n of [1, 2]) {
    await until(uploading, 120_000);
    await sleep(2_500);
    say(`Connection dropped (${n}/2).`);
    http.online = false;
    await sleep(3_000);
    http.online = true;
    outbox.connectivityChanged(true);
    say('Connection back.');
  }

  await until(uploading, 120_000);
  await sleep(2_000);
  say('Force-quit mid-upload.');
  unwatch();
  await outbox.stop();
  outbox = makeOutbox(http);
  await outbox.start();
  unwatch = watch(outbox);
  say('Reopened.');

  await until(() => outbox.getSnapshot().reports.every(r => r.state === 'uploaded'), 15 * 60_000);
  unwatch();
  await outbox.stop();
  await admin('DELETE', '/__chaos');

  // ── 4. Check the server ────────────────────────────────────────────────────
  const { reports } = (await admin('GET', '/v1/reports')) as {
    reports: { id: string; description: string; images: { id: string; size: number; width: number; height: number; url: string }[] }[];
  };
  const failures: string[] = [];
  if (reports.length !== 3) failures.push(`expected 3 reports on the server, found ${reports.length}`);
  for (const id of ids) {
    const matches = reports.filter(r => r.id === id);
    if (matches.length !== 1) failures.push(`report ${id} present ${matches.length} times`);
  }
  for (const r of reports) {
    say(`✔ "${r.description}"`);
    for (const img of r.images) {
      const bytes = Buffer.from(await (await fetch(SERVER + img.url)).arrayBuffer());
      const meta = await sharp(bytes).metadata();
      const ok = bytes.length === img.size && img.size <= LIMITS.maxImageBytes && meta.format === 'jpeg';
      say(`    ${ok ? '✔' : '✘'} ${(img.size / 1e6).toFixed(2)} MB  ${meta.width}×${meta.height}`);
      if (!ok) failures.push(`image ${img.id} failed checks`);
    }
  }
  const leftovers = await fs.readdir(disk.photos).catch(() => []);
  if (leftovers.length) failures.push(`${leftovers.length} files left in the photo dir`);

  await fs.rm(work, { recursive: true, force: true });
  if (failures.length) {
    say(`FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  say('PASS: three reports, exactly once each, every image intact and under 5,000,000 bytes.');
}

main().catch(async e => {
  console.error(e);
  await admin('DELETE', '/__chaos').catch(() => {});
  process.exit(1);
});
