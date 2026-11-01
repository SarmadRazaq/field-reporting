/**
 * Picks the chunk size from how the link behaved recently. Small chunks mean a
 * drop costs little; big chunks mean fewer round trips when the link is good.
 * Starts small because 2G is the normal case here.
 */
export class ChunkSizer {
  static readonly MIN = 16 * 1024;
  static readonly MAX = 1024 * 1024;
  static readonly START = 64 * 1024;
  /** A chunk faster than this means the link can take a bigger one. */
  static readonly FAST_MS = 4_000;

  private size = ChunkSizer.START;

  get current(): number {
    return this.size;
  }

  succeeded(bytes: number, elapsedMs: number) {
    if (bytes >= this.size && elapsedMs < ChunkSizer.FAST_MS) this.size = Math.min(ChunkSizer.MAX, this.size * 2);
  }

  /** The chunk timed out or the connection dropped mid-body. */
  struggled() {
    this.size = Math.max(ChunkSizer.MIN, Math.floor(this.size / 2));
  }
}
