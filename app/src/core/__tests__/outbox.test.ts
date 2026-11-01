import { ChunkSizer } from '../chunking';
import { summarize, describeReport } from '../status';
import { LIMITS } from '../types';
import { MB, fileReport, flush, settle, sha, world, type World } from './fakes';

/** Every committed report's images match, byte for byte, what the phone prepared. */
function expectIntact(w: World) {
  for (const report of w.server.committed()) {
    for (const image of report.images) {
      expect(image.bytes.length).toBe(image.size);
      expect(image.size).toBeLessThanOrEqual(LIMITS.maxImageBytes);
      expect(sha(image.bytes)).toBe(image.sha256);
    }
  }
}

const states = (w: World) => w.outbox.getSnapshot().reports.map(r => r.state);

describe('composing', () => {
  it('refuses zero photos, a blank description, and a sixth photo', async () => {
    const w = await world();
    const draft = await w.outbox.startDraft();
    expect(await w.outbox.submit(draft.id)).toEqual({ ok: false, issues: ['no_photos', 'description_required'] });

    const uris = Array.from({ length: 6 }, (_, i) => {
      w.files.gallery.set(`content://p${i}`, new Uint8Array(1000));
      return `content://p${i}`;
    });
    expect(await w.outbox.addPhotos(draft.id, uris)).toBe(5);
    await w.outbox.setDescription(draft.id, '   \n ');
    expect(await w.outbox.submit(draft.id)).toEqual({ ok: false, issues: ['description_required'] });
  });

  it('keeps a draft, with its photos, across a force-quit', async () => {
    const w = await world();
    w.files.gallery.set('content://a', new Uint8Array(5000));
    const draft = await w.outbox.startDraft();
    await w.outbox.setDescription(draft.id, 'Half written');
    await w.outbox.addPhotos(draft.id, ['content://a']);
    w.files.gallery.clear(); // the picker's copy is gone after the kill

    const outbox = await w.relaunch();
    const restored = outbox.currentDraft()!;
    expect(restored.description).toBe('Half written');
    expect(await w.files.size(restored.images[0]!.sourcePath!)).toBe(5000);
  });
});

describe('delivery', () => {
  it('uploads a report with five 18 MB photos, each under the ceiling', async () => {
    const w = await world();
    await fileReport(w, [18, 18, 18, 18, 18].map(n => n * MB));
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
    expect(w.server.committed()[0]!.images).toHaveLength(5);
    expectIntact(w);
    expect(states(w)).toEqual(['uploaded']);
    expect(w.files.files.size).toBe(0); // local copies are dropped after the server confirms
  });

  it('steps down the quality ladder for a photo that will not fit, and never sends one over', async () => {
    const w = await world();
    w.encoder.sizeFor = (_src, req) => (req.maxEdge >= 3072 ? 6 * MB : 3 * MB);
    await fileReport(w, [40 * MB]);
    await settle(w);
    expect(w.encoder.calls.map(c => c.maxEdge)).toEqual([4096, 4096, 3072, 2560]);
    expectIntact(w);
  });

  it('falls back to a smaller size when the encoder runs out of memory', async () => {
    const w = await world();
    w.encoder.failAboveEdge = 3072;
    await fileReport(w, [20 * MB]);
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
    expect(w.encoder.calls.map(c => c.maxEdge)).toEqual([4096, 4096, 3072]);
  });

  it('marks a photo that cannot be decoded at all', async () => {
    const w = await world();
    const id = await fileReport(w, [1 * MB]);
    void id;
    w.encoder.failAboveEdge = 0;
    await settle(w);
    const [report] = w.outbox.getSnapshot().reports;
    expect(report!.problem).toMatchObject({ code: 'photo_unreadable', message: 'Photo 1 could not be read as an image' });
  });

  it('gives up on a photo nothing can shrink, before any byte goes out', async () => {
    const w = await world();
    w.encoder.sizeFor = () => 7 * MB;
    await fileReport(w, [40 * MB]);
    await settle(w);
    expect(states(w)).toEqual(['needs_attention']);
    expect(w.server.requests).toHaveLength(0);
  });

  it('waits out airplane mode, then delivers three reports exactly once', async () => {
    const w = await world();
    w.server.offline = true;
    await fileReport(w, [18 * MB, 18 * MB, 18 * MB, 18 * MB, 18 * MB]);
    await fileReport(w, [3 * MB]);
    await fileReport(w, [6 * MB, 2 * MB]);
    await flush();
    await w.outbox.idle();
    const summary = summarize(w.outbox.getSnapshot(), w.clock.now());
    expect(summary.title).toBe('3 reports saved on this phone');
    expect(summary.detail).toMatch(/Waiting for signal/);

    w.server.offline = false;
    w.outbox.connectivityChanged(true);
    await settle(w);
    expect(w.server.committed()).toHaveLength(3);
    expect(w.server.committed().every(r => r.commits === 1)).toBe(true);
    expectIntact(w);
  });

  it('survives connections that drop mid-chunk, repeatedly', async () => {
    const w = await world();
    w.server.inject('chunk', { kind: 'drop', afterBytes: 10_000 }, 6);
    await fileReport(w, [18 * MB]);
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
    expectIntact(w);
  });

  it('lands once when the commit reply is lost', async () => {
    const w = await world();
    w.server.inject('commit', { kind: 'lose-response' });
    await fileReport(w, [2 * MB]);
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
    expect(w.server.committed()[0]!.commits).toBe(1);
    expect(states(w)).toEqual(['uploaded']);
  });

  it('retries 5xx, timeouts and 429, and nothing else', async () => {
    const w = await world();
    w.server.inject('manifest', { kind: 'status', status: 503 });
    w.server.inject('chunk', { kind: 'timeout' });
    w.server.inject('commit', { kind: 'status', status: 429, headers: { 'retry-after': '5' } });
    await fileReport(w, [1 * MB]);
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
  });

  it('stops on a permanent refusal and does not retry it', async () => {
    const w = await world();
    w.server.inject('manifest', { kind: 'status', status: 413 });
    await fileReport(w, [1 * MB]);
    await settle(w);
    const before = w.server.requests.length;
    w.outbox.retryNow('test');
    await settle(w);
    expect(w.server.requests.length).toBe(before);
    const [report] = w.outbox.getSnapshot().reports;
    expect(report!.state).toBe('needs_attention');
    expect(describeReport(report!, null, w.clock.now()).tone).toBe('attention');

    // The user fixes the server and taps Retry.
    await w.outbox.retryReport(report!.id);
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
  });

  it('re-sends a photo that arrived corrupted', async () => {
    const w = await world();
    w.server.inject('chunk', { kind: 'corrupt' });
    await fileReport(w, [1 * MB]);
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
    expectIntact(w);
  });

  it('starts over when the server has forgotten the report', async () => {
    const w = await world();
    const id = await fileReport(w, [2 * MB]);
    w.server.inject('chunk', { kind: 'freeze' });
    await flush();
    await flush();
    w.server.reports.delete(id); // e.g. the server was reset while we were mid-upload
    const outbox = await w.relaunch();
    await outbox.idle();
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
    expectIntact(w);
  });
});

describe('force-quit', () => {
  it('resumes mid-photo from the bytes the server already has', async () => {
    const w = await world();
    await fileReport(w, [4 * MB]);
    // Let a few chunks through, then freeze: the process "dies" with a request in flight.
    for (let i = 0; i < 30 && (w.server.reports.values().next().value?.images[0]?.bytes.length ?? 0) < 300_000; i++)
      await flush();
    w.server.inject('chunk', { kind: 'freeze' });
    await flush();
    const sentBefore = w.server.reports.values().next().value!.images[0]!.bytes.length;
    expect(sentBefore).toBeGreaterThan(0);

    await w.relaunch();
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
    expectIntact(w);
    // It resumed, rather than starting the photo again.
    const patches = w.server.requests.filter(r => r.route === 'chunk').length;
    expect(patches).toBeLessThan(Math.ceil((2 * 4 * MB) / ChunkSizer.START));
  });

  it('redoes a photo whose processing was interrupted, and cleans up the leftovers', async () => {
    const w = await world();
    w.server.offline = true;
    const id = await fileReport(w, [10 * MB, 10 * MB]);
    const second = (await w.repo.load()).find(r => r.id === id)!.images[1]!;
    w.encoder.hangOn.add(second.sourcePath!);
    await flush();
    await flush();
    w.files.files.set(`${w.files.photosDir}/stray.tmp.jpg`, new Uint8Array(10));

    w.encoder.hangOn.clear();
    w.server.offline = false;
    await w.relaunch();
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
    expect(w.files.files.size).toBe(0);
  });

  it('gives up on a photo that keeps crashing the encoder instead of crash-looping', async () => {
    const w = await world();
    const id = await fileReport(w, [10 * MB]);
    void id;
    for (let i = 0; i < 3; i++) {
      const [report] = await w.repo.load();
      w.encoder.hangOn.add(report!.images[0]!.sourcePath!);
      await w.relaunch();
      await flush();
    }
    w.encoder.hangOn.clear();
    await w.relaunch();
    await settle(w);
    expect(states(w)).toEqual(['needs_attention']);
  });
});

describe('reset', () => {
  it('wipes everything on the phone, and a late reply cannot bring it back', async () => {
    const w = await world();
    await fileReport(w, [3 * MB]);
    w.server.inject('chunk', { kind: 'freeze' });
    await flush();
    await flush();
    const draft = await w.outbox.startDraft();
    w.files.gallery.set('content://x', new Uint8Array(100));
    await w.outbox.addPhotos(draft.id, ['content://x']);

    await w.outbox.reset();
    await settle(w);
    expect(w.outbox.getSnapshot().reports).toHaveLength(0);
    expect(w.repo.rows.size).toBe(0);
    expect(w.files.files.size).toBe(0);
    expect(w.clock.pendingTimers()).toBe(0);
    expect(w.outbox.hasPendingWork()).toBe(false);

    const outbox = await w.relaunch();
    expect(outbox.getSnapshot().reports).toHaveLength(0);
  });
});

describe('what the user is told', () => {
  it('never puts "saved" and "uploaded" in one sentence', async () => {
    const w = await world();
    const seen = new Set<string>();
    w.outbox.subscribe(() => {
      const s = w.outbox.getSnapshot();
      const lines = [summarize(s, w.clock.now()), ...s.reports.map(r => describeReport(r, s.activity, w.clock.now()))];
      for (const l of lines) for (const text of [l.title, l.detail ?? '']) seen.add(text);
    });
    w.server.inject('chunk', { kind: 'offline' }, 2);
    w.server.inject('manifest', { kind: 'status', status: 500 });
    await fileReport(w, [5 * MB, 1 * MB]);
    await fileReport(w, [1 * MB]);
    await settle(w);

    expect(seen.size).toBeGreaterThan(5);
    for (const text of seen) {
      const saved = /\bsaved\b/i.test(text);
      const uploaded = /\buploaded\b/i.test(text);
      expect({ text, both: saved && uploaded }).toEqual({ text, both: false });
    }
    expect(summarize(w.outbox.getSnapshot(), w.clock.now()).title).toBe('Everything is on the server');
  });
});
