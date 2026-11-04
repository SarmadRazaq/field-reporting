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

/** Fires timers while a delivery is still running (settle() waits for idle first, so it can't fire a wait inside one). */
async function pump(w: World, rounds = 100) {
  for (let i = 0; i < rounds; i++) {
    await flush();
    w.clock.fireNext();
  }
  await settle(w);
}

describe('composing', () => {
  it('refuses zero photos, a blank description, and a sixth photo', async () => {
    const w = await world();
    const draft = await w.outbox.drafts.start();
    expect(await w.outbox.drafts.submit(draft.id)).toEqual({ ok: false, issues: ['no_photos', 'description_required'] });

    const uris = Array.from({ length: 6 }, (_, i) => {
      w.files.gallery.set(`content://p${i}`, new Uint8Array(1000));
      return `content://p${i}`;
    });
    expect(await w.outbox.drafts.addPhotos(draft.id, uris)).toBe(5);
    await w.outbox.drafts.setDescription(draft.id, '   \n ');
    expect(await w.outbox.drafts.submit(draft.id)).toEqual({ ok: false, issues: ['description_required'] });
  });

  it('keeps a draft, with its photos, across a force-quit', async () => {
    const w = await world();
    w.files.gallery.set('content://a', new Uint8Array(5000));
    const draft = await w.outbox.drafts.start();
    await w.outbox.drafts.setDescription(draft.id, 'Half written');
    await w.outbox.drafts.addPhotos(draft.id, ['content://a']);
    w.files.gallery.clear(); // the picker's copy is gone after the kill

    const outbox = await w.relaunch();
    const restored = outbox.drafts.current()!;
    expect(restored.description).toBe('Half written');
    const photo = restored.images[0]!;
    expect(await w.files.size(photo.processed?.path ?? photo.sourcePath!)).not.toBeNull();
  });

  it('prepares photos as they are added, so Save has nothing left to do', async () => {
    const w = await world();
    w.server.offline = true;
    w.files.gallery.set('content://a', new Uint8Array(18 * MB));
    w.files.gallery.set('content://b', new Uint8Array(18 * MB));
    const draft = await w.outbox.drafts.start();
    await w.outbox.drafts.addPhotos(draft.id, ['content://a', 'content://b']);
    await w.outbox.drafts.idle();

    const images = w.outbox.drafts.current()!.images;
    expect(images.every(i => i.processed && i.processed.size <= LIMITS.targetImageBytes)).toBe(true);
    expect(images.every(i => i.sourcePath === null)).toBe(true); // originals dropped once prepared
  });

  it('finds an unreadable photo while composing, blocks Save until it is removed', async () => {
    const w = await world();
    w.files.gallery.set('content://good', new Uint8Array(MB));
    w.files.gallery.set('content://bad', new Uint8Array(MB));
    const draft = await w.outbox.drafts.start();
    await w.outbox.drafts.setDescription(draft.id, 'Cracked beam');
    await w.outbox.drafts.addPhotos(draft.id, ['content://good']);
    await w.outbox.drafts.idle();
    w.encoder.failAboveEdge = 0;
    await w.outbox.drafts.addPhotos(draft.id, ['content://bad']);
    await w.outbox.drafts.idle();

    const bad = w.outbox.drafts.current()!.images[1]!;
    expect(bad.problem).toMatchObject({ code: 'photo_unreadable', message: 'Photo 2 could not be read as an image' });
    expect(await w.outbox.drafts.submit(draft.id)).toEqual({ ok: false, issues: ['photo_problem'] });
    expect(w.server.requests).toHaveLength(0);

    await w.outbox.drafts.removePhoto(draft.id, bad.id);
    expect(await w.outbox.drafts.submit(draft.id)).toEqual({ ok: true });
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
  });

  it('gives up on a photo that keeps crashing the encoder while composing', async () => {
    const w = await world();
    w.files.gallery.set('content://a', new Uint8Array(MB));
    const draft = await w.outbox.drafts.start();
    w.encoder.hangAll = true;
    await w.outbox.drafts.addPhotos(draft.id, ['content://a']);
    for (let i = 0; i < 3; i++) {
      await flush();
      await w.relaunch(); // each launch tries it again, and "crashes"
    }
    w.encoder.hangAll = false;
    await w.relaunch();
    await w.outbox.drafts.idle();
    expect(w.outbox.drafts.current()!.images[0]!.problem).toMatchObject({ code: 'photo_unreadable' });
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

  // Photo 1 is prepared while composing; photo 2 is still waiting when Save is tapped, so the uploader prepares it.
  it('marks a photo that cannot be decoded at all', async () => {
    const w = await world();
    await fileReport(w, [1 * MB, 1 * MB]);
    w.encoder.failAboveEdge = 0;
    await settle(w);
    const [report] = w.outbox.getSnapshot().reports;
    expect(report!.problem).toMatchObject({ code: 'photo_unreadable', message: 'Photo 2 could not be read as an image' });
  });

  it('gives up on a photo nothing can shrink, before any byte goes out', async () => {
    const w = await world();
    await fileReport(w, [1 * MB, 40 * MB]);
    w.encoder.sizeFor = () => 7 * MB;
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
    expect(summary).toEqual({ kind: 'waiting', text: 'No signal · 3 reports on this phone' });
    const first = w.outbox.getSnapshot().reports[0]!;
    expect(describeReport(first, null, w.clock.now())).toMatchObject({ kind: 'waiting', label: 'Waiting for signal' });

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
    expect(describeReport(report!, null, w.clock.now())).toMatchObject({ kind: 'refused', label: "Couldn't send" });

    // The user fixes the server and taps Retry.
    await w.outbox.retryReport(report!.id);
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
  });

  it('replaces one refused photo and sends the report again, keeping the others', async () => {
    const w = await world();
    w.server.inject('commit', { kind: 'status', status: 422 }); // the server held the manifest, then refused
    await fileReport(w, [1 * MB, 1 * MB], 'Corroded flange');
    await settle(w);
    const [refused] = w.outbox.getSnapshot().reports;
    expect(refused!.state).toBe('needs_attention');
    const kept = refused!.images[0]!.processed!.sha256;

    w.files.gallery.set('content://retake', new Uint8Array(2 * MB));
    const newId = await w.outbox.replacePhoto(refused!.id, refused!.images[1]!.id, 'content://retake');
    await settle(w);

    expect(newId).not.toBe(refused!.id);
    expect(states(w)).toEqual(['uploaded']);
    const [sent] = w.server.committed();
    expect(sent!.id).toBe(newId);
    expect(sent!.description).toBe('Corroded flange');
    expect(sent!.images.map(i => i.sha256)[0]).toBe(kept); // the good photo wasn't redone
    expectIntact(w);
    expect(w.files.files.size).toBe(0);
  });

  it('calls out a server that has been failing for half an hour, and keeps trying', async () => {
    const w = await world();
    w.server.inject('any', { kind: 'status', status: 500 }, 1000);
    await fileReport(w, [1 * MB]);
    await settle(w, 10);
    const early = w.outbox.getSnapshot();
    expect(describeReport(early.reports[0]!, null, w.clock.now()).kind).toBe('waiting');
    expect(summarize(early, w.clock.now()).kind).toBe('waiting');

    await settle(w, 40); // 60 s apart at most: well past 30 minutes
    const late = w.outbox.getSnapshot();
    expect(describeReport(late.reports[0]!, null, w.clock.now())).toMatchObject({
      kind: 'stuck',
      label: 'Server not accepting reports',
    });
    expect(summarize(late, w.clock.now()).kind).toBe('stuck');

    w.server.clearFaults();
    await settle(w);
    expect(states(w)).toEqual(['uploaded']);
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

describe('send this first', () => {
  it('lets a small report overtake a big one mid-upload, and both land once', async () => {
    const w = await world();
    // Hold the big report's first chunk in flight, as a slow 2G upload would be.
    w.server.inject('chunk', { kind: 'freeze' });
    const big = await fileReport(w, [18 * MB, 18 * MB, 18 * MB, 18 * MB, 18 * MB], 'Big');
    for (let i = 0; i < 10; i++) await flush();
    expect(w.outbox.getSnapshot().activity).toMatchObject({ reportId: big, stage: 'uploading' });
    const small = await fileReport(w, [2 * MB], 'Small');

    await w.outbox.sendFirst(small);
    await settle(w);

    const commits = w.server.requests.filter(r => r.route === 'commit').map(r => r.path.split('/')[3]);
    expect(commits[0]).toBe(small);
    expect(w.server.committed()).toHaveLength(2);
    expect(w.server.committed().every(r => r.commits === 1)).toBe(true);
    expectIntact(w);
    // Pausing is not a failure.
    expect(w.logs.some(l => l.includes('attempt'))).toBe(false);
  });
});

describe('contact and backoff', () => {
  it('remembers when the server last answered', async () => {
    const w = await world();
    expect(w.outbox.getSnapshot().lastContactAt).toBeNull();
    await fileReport(w, [1 * MB]);
    await settle(w);
    expect(w.outbox.getSnapshot().lastContactAt).toBe(w.clock.now());
  });

  it('waits longer between tries while the phone says it is offline', async () => {
    const w = await world();
    w.server.offline = true;
    w.outbox.connectivityChanged(false);
    await fileReport(w, [1 * MB]);
    for (let i = 0; i < 12; i++) {
      await flush();
      await w.outbox.idle();
      w.clock.fireNext();
    }
    await w.outbox.idle();
    const [r] = w.outbox.getSnapshot().reports;
    expect(r!.nextAttemptAt! - w.clock.now()).toBeGreaterThan(60_000);
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
    // Photo 2 is still unprepared at Save, so it is the uploader that keeps crashing on it.
    await fileReport(w, [1 * MB, 10 * MB]);
    for (let i = 0; i < 3; i++) {
      const [report] = await w.repo.load();
      w.encoder.hangOn.add(report!.images[1]!.sourcePath!);
      await w.relaunch();
      await flush();
    }
    w.encoder.hangOn.clear();
    await w.relaunch();
    await settle(w);
    expect(states(w)).toEqual(['needs_attention']);
  });
});

describe('hand-off to the native sender', () => {
  const mid = async (w: World) => {
    for (let i = 0; i < 10; i++) await flush();
    expect(w.outbox.getSnapshot().activity?.stage).toBe('uploading');
  };

  it('stops sending and hands over the ready reports, oldest first', async () => {
    const w = await world();
    w.server.inject('chunk', { kind: 'freeze' });
    const first = await fileReport(w, [6 * MB], 'First');
    const second = await fileReport(w, [2 * MB], 'Second');
    await mid(w);

    const handed = w.outbox.pause()!;
    await settle(w);
    const sent = w.server.requests.length;
    w.outbox.retryNow('connectivity');
    w.outbox.kick('submit');
    await settle(w);

    expect(handed.map(r => r.id)).toEqual([first, second]);
    expect(handed[0]!.images[0]).toMatchObject({ size: expect.any(Number), sha256: expect.any(String) });
    expect(w.server.requests.length).toBe(sent);
    expect(w.clock.pendingTimers()).toBe(0);
    expect(w.logs.some(l => l.includes('attempt'))).toBe(false);
  });

  it('applies what the native sender did, and leaves the rest to carry on', async () => {
    const w = await world();
    w.server.inject('chunk', { kind: 'freeze' });
    const sent = await fileReport(w, [2 * MB], 'Sent in the background');
    const refused = await fileReport(w, [2 * MB], 'Refused');
    const partly = await fileReport(w, [2 * MB], 'Partly sent');
    await mid(w);
    const handed = w.outbox.pause()!;
    const photo = handed.find(r => r.id === partly)!.images[0]!.id;

    await w.outbox.resume([
      { id: sent, kind: 'uploaded', at: Date.parse('2026-11-03T10:00:00Z') },
      { id: refused, kind: 'needs_attention', problem: { code: 'too_large', message: 'Too large', status: 413 } },
      { id: partly, kind: 'pending', uploadedBytes: { [photo]: 65_536 }, issue: null },
      { id: 'not-on-this-phone', kind: 'uploaded', at: 0 },
    ]);
    const byId = (id: string) => w.outbox.getSnapshot().reports.find(r => r.id === id)!;
    expect(byId(sent)).toMatchObject({ state: 'uploaded', uploadedAt: '2026-11-03T10:00:00.000Z' });
    expect(byId(refused)).toMatchObject({ state: 'needs_attention', problem: { code: 'too_large' } });
    expect(byId(partly).images[0]!.uploadedBytes).toBe(65_536);
    // The background-sent report's photos are gone from the phone; the refused one keeps its own.
    expect(w.files.files.size).toBe(2);

    await settle(w);
    expect(w.server.committed().map(r => r.id)).toEqual([partly]);
    expect(byId(partly).state).toBe('uploaded');
  });

  it('waits out a photo the server is still busy with after a take-back, without calling it a failure', async () => {
    const w = await world();
    // The native sender's last chunk, cancelled at the take-back, is still holding the photo on the server.
    w.server.inject('chunk', { kind: 'status', status: 423, headers: { 'retry-after': '2' } }, 2);
    const issues: unknown[] = [];
    w.outbox.subscribe(() => {
      for (const r of w.outbox.getSnapshot().reports) if (r.lastIssue || r.attempts > 0) issues.push(r.lastIssue);
    });
    await fileReport(w, [1 * MB]);
    await pump(w);
    expect(issues).toEqual([]);
    expect(states(w)).toEqual(['uploaded']);
    expect(w.server.committed()[0]!.commits).toBe(1);
    expectIntact(w);
  });

  it('treats a photo that stays busy as a transient failure, never as needing attention', async () => {
    const w = await world();
    w.server.inject('chunk', { kind: 'status', status: 423 }, 8);
    await fileReport(w, [1 * MB]);
    await pump(w);
    expect(states(w)).toEqual(['uploaded']);
    expect(w.server.committed()[0]!.commits).toBe(1);
  });

  it('carries on from the server\'s bytes when taken back with no news, and lands once', async () => {
    const w = await world();
    w.server.inject('chunk', { kind: 'drop', afterBytes: 10_000 });
    await fileReport(w, [6 * MB]);
    for (let i = 0; i < 30 && w.server.requests.filter(r => r.route === 'chunk').length < 3; i++) await flush();
    w.outbox.pause();
    await w.outbox.resume();
    await settle(w);
    expect(w.server.committed()).toHaveLength(1);
    expect(w.server.committed()[0]!.commits).toBe(1);
    expectIntact(w);
  });

  it('does not hand over during a reset', async () => {
    const w = await world();
    w.server.inject('commit', { kind: 'hold' });
    await fileReport(w, [2 * MB]);
    for (let i = 0; i < 50 && w.server.holding() === 0; i++) await flush();
    const resetting = w.outbox.reset();
    expect(w.outbox.pause()).toBeNull();
    w.server.release();
    await resetting;
  });
});

describe('reset', () => {
  async function untilCommitHeld(w: World) {
    for (let i = 0; i < 50 && w.server.holding() === 0; i++) await flush();
    expect(w.server.holding()).toBe(1);
  }

  it('waits for a commit already sent, and says the report reached the server', async () => {
    const w = await world();
    w.server.inject('commit', { kind: 'hold' });
    const id = await fileReport(w, [2 * MB], 'Mid-commit');
    await untilCommitHeld(w);

    const resetting = w.outbox.reset();
    await flush();
    w.server.release();
    const outcome = await resetting;

    expect(outcome).toEqual({ reachedServer: [{ id, description: 'Mid-commit' }], mayHaveReachedServer: [] });
    expect(w.server.committed()).toHaveLength(1);
    expect(w.repo.rows.size).toBe(0);
    expect(w.files.files.size).toBe(0);
  });

  it('gives up waiting on a commit that never answers, and says it may have reached the server', async () => {
    const w = await world();
    w.server.inject('commit', { kind: 'freeze' });
    const id = await fileReport(w, [2 * MB], 'Silent server');
    for (let i = 0; i < 50 && w.outbox.getSnapshot().activity?.stage !== 'committing'; i++) await flush();

    const resetting = w.outbox.reset();
    await flush();
    w.clock.fireNext(); // the wait runs out
    const outcome = await resetting;

    expect(outcome.mayHaveReachedServer).toEqual([{ id, description: 'Silent server' }]);
    expect(outcome.reachedServer).toEqual([]);
    expect(w.repo.rows.size).toBe(0);
  });

  it('does not wait when nothing is being committed', async () => {
    const w = await world();
    w.server.inject('chunk', { kind: 'freeze' });
    await fileReport(w, [2 * MB]);
    for (let i = 0; i < 10; i++) await flush();
    expect(w.outbox.getSnapshot().activity?.stage).toBe('uploading');

    expect(await w.outbox.reset()).toEqual({ reachedServer: [], mayHaveReachedServer: [] });
    await settle(w);
    expect(w.server.committed()).toHaveLength(0);
  });

  it('reports what the native sender sent or had a commit out for, and is not left paused', async () => {
    const w = await world();
    w.server.offline = true;
    await fileReport(w, [1 * MB], 'Sent in the background');
    await fileReport(w, [1 * MB], 'Commit was out');
    await fileReport(w, [1 * MB], 'Halfway through a photo');
    await settle(w);
    const [sent, committing, partway] = w.outbox.getSnapshot().reports.map(r => r.id);
    const handed = w.outbox.pause();
    expect(handed).toHaveLength(3);

    // What the stopped native sender handed back at the reset.
    const outcome = await w.outbox.reset([
      { id: sent!, kind: 'uploaded', at: w.clock.now() },
      { id: committing!, kind: 'pending', uploadedBytes: {}, issue: null, committing: true },
      { id: partway!, kind: 'pending', uploadedBytes: {}, issue: null },
      { id: 'not-on-this-phone', kind: 'uploaded', at: w.clock.now() },
    ]);
    expect(outcome).toEqual({
      reachedServer: [{ id: sent, description: 'Sent in the background' }],
      mayHaveReachedServer: [{ id: committing, description: 'Commit was out' }],
    });
    expect(w.outbox.getSnapshot().reports).toHaveLength(0);

    // Sending works straight after, without a take-back.
    w.server.offline = false;
    await fileReport(w, [1 * MB]);
    await settle(w);
    expect(states(w)).toEqual(['uploaded']);
  });

  it('wipes everything on the phone, and a late reply cannot bring it back', async () => {
    const w = await world();
    await fileReport(w, [3 * MB]);
    w.server.inject('chunk', { kind: 'freeze' });
    await flush();
    await flush();
    const draft = await w.outbox.drafts.start();
    w.files.gallery.set('content://x', new Uint8Array(100));
    await w.outbox.drafts.addPhotos(draft.id, ['content://x']);

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
  it('never puts "saved" and "sent" in one sentence', async () => {
    const w = await world();
    const seen = new Set<string>();
    w.outbox.subscribe(() => {
      const s = w.outbox.getSnapshot();
      seen.add(summarize(s, w.clock.now()).text);
      for (const r of s.reports) {
        const status = describeReport(r, s.activity, w.clock.now());
        seen.add(status.label);
        seen.add(status.detail ?? '');
      }
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
    expect(summarize(w.outbox.getSnapshot(), w.clock.now()).kind).toBe('all-sent');
  });
});
