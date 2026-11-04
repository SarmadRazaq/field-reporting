import { describeReset } from '../resetProgress';

describe('describeReset', () => {
  const t0 = Date.parse('2026-11-05T09:00:00Z');

  it('says nothing when no reset is running', () => {
    expect(describeReset({ phase: 'idle' }, t0)).toBeNull();
  });

  it('counts down to the bound of the wait, and stops at zero', () => {
    const p = { phase: 'confirming' as const, startedAt: t0, until: t0 + 32_000 };
    expect(describeReset(p, t0)).toEqual({ text: expect.stringContaining('already confirming'), secondsLeft: 32 });
    expect(describeReset(p, t0 + 31_500)?.secondsLeft).toBe(1);
    expect(describeReset(p, t0 + 40_000)?.secondsLeft).toBe(0);
  });

  it('shows no countdown for a step that never waits on the network', () => {
    expect(describeReset({ phase: 'deleting', startedAt: t0, until: null }, t0)).toEqual({
      text: expect.any(String),
      secondsLeft: null,
    });
  });

  it('names what it is waiting on in every phase', () => {
    for (const phase of ['stopping', 'confirming', 'deleting', 'server'] as const) {
      expect(describeReset({ phase, startedAt: t0, until: null }, t0)?.text).toMatch(/\.$/);
    }
  });
});
