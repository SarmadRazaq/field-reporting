import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

type Ctx = Awaited<ReturnType<typeof createApp>>;
let ctx: Ctx;
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-reports-auth-'));
  ctx = await createApp({ dataDir: dir, log: () => {}, adminToken: 's3cret' });
});
afterEach(async () => {
  ctx.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('admin token', () => {
  it('refuses the admin page and chaos controls without it', async () => {
    const page = await request(ctx.app).get('/admin');
    expect(page.status).toBe(401);
    expect(page.headers['www-authenticate']).toMatch(/^Basic/);
    expect((await request(ctx.app).put('/__chaos').send({ latencyMs: 1 })).status).toBe(401);
    expect((await request(ctx.app).get('/__admin/reports')).status).toBe(401);
    expect((await request(ctx.app).get('/__chaos').set('authorization', 'Bearer wrong')).status).toBe(401);
  });

  it('accepts it as a Bearer token or a Basic password', async () => {
    expect((await request(ctx.app).get('/__chaos').set('authorization', 'Bearer s3cret')).status).toBe(200);
    expect((await request(ctx.app).get('/admin').auth('anyone', 's3cret')).status).toBe(200);
  });

  it('leaves the upload protocol open', async () => {
    expect((await request(ctx.app).get('/v1/health')).status).toBe(200);
  });
});
