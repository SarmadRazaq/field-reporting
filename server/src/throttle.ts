import { Transform } from 'node:stream';

const TICK_MS = 100;

/**
 * Passes bytes through no faster than `rate()` bytes per second. The rate is
 * re-read on every tick, so changing chaos settings mid-transfer takes effect
 * immediately.
 */
export function throttle(rate: () => number): Transform {
  return new Transform({
    async transform(chunk: Buffer, _enc, done) {
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const bytesPerSec = rate();
          if (bytesPerSec <= 0) {
            this.push(chunk.subarray(offset));
            break;
          }
          const slice = Math.max(1, Math.floor((bytesPerSec * TICK_MS) / 1000));
          this.push(chunk.subarray(offset, offset + slice));
          offset += slice;
          await new Promise(r => setTimeout(r, TICK_MS));
        }
        done();
      } catch (e) {
        done(e as Error);
      }
    },
  });
}
