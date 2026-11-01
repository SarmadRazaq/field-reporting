import { REPORT_SCHEMA, parseReport, serializeReport } from '../schema';

/** A report as the first release stored it: no schema field, no `since`, no per-photo problem. */
const v1 = {
  id: 'r1',
  description: 'Leaking valve',
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: 1,
  state: 'uploading',
  images: [{ id: 'i1', sourcePath: null, sourceBytes: 10, processed: null, processingAttempts: 1, uploadedBytes: 0 }],
  attempts: 2,
  nextAttemptAt: 5,
  lastIssue: { reason: 'offline', message: 'No connection', at: 1234 },
  problem: null,
  uploadedAt: null,
};

describe('stored reports', () => {
  it('upgrades a report saved by the first release', () => {
    const r = parseReport(JSON.stringify(v1));
    expect(r.lastIssue).toEqual({ reason: 'offline', message: 'No connection', at: 1234, since: 1234 });
    expect(r.images[0]!.problem).toBeNull();
    expect(r).not.toHaveProperty('schema');
  });

  it('round-trips the current schema unchanged', () => {
    const r = parseReport(JSON.stringify(v1));
    const stored = serializeReport(r);
    expect(JSON.parse(stored).schema).toBe(REPORT_SCHEMA);
    expect(parseReport(stored)).toEqual(r);
  });
});
