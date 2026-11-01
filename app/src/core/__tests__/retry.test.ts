import { NetworkError } from '../ports';
import { backoffMs, classifyNetwork, classifyResponse } from '../retry';

describe('classifyResponse', () => {
  it.each([
    [408, 'transient'],
    [423, 'transient'],
    [429, 'transient'],
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
    [404, 'restart'],
    [400, 'permanent'],
    [401, 'permanent'],
    [403, 'permanent'],
    [409, 'permanent'],
    [413, 'permanent'],
    [422, 'permanent'],
  ])('%i → %s', (status, type) => {
    expect(classifyResponse(status, {}).type).toBe(type);
  });

  it('honours Retry-After', () => {
    const f = classifyResponse(429, {}, { 'retry-after': '30' });
    expect(f).toMatchObject({ type: 'transient', retryAfterMs: 30_000 });
  });

  it('keeps the server message for refusals', () => {
    const f = classifyResponse(413, { message: 'images[2] is 6000000 bytes' });
    expect(f).toMatchObject({ type: 'permanent', problem: { code: 'too_large', message: 'images[2] is 6000000 bytes' } });
  });
});

describe('network failures', () => {
  it('are always transient', () => {
    expect(classifyNetwork(new NetworkError('offline', 'x')).type).toBe('transient');
    expect(classifyNetwork(new NetworkError('timeout', 'x'))).toMatchObject({ type: 'transient', reason: 'timeout' });
  });
});

describe('backoffMs', () => {
  it('grows exponentially, jittered, capped at 60 s', () => {
    expect(backoffMs(1, () => 1)).toBe(2_000);
    expect(backoffMs(1, () => 0)).toBe(1_000);
    expect(backoffMs(3, () => 1)).toBe(8_000);
    expect(backoffMs(20, () => 1)).toBe(60_000);
  });
});
