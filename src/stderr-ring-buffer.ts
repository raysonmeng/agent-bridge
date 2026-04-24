/**
 * Bounded ring buffer for tailing a child process's stderr.
 *
 * The wrapper around `codex` needs to surface the last N bytes the child
 * printed to stderr before exiting — in particular the `ERROR: ...` line
 * emitted by codex-rs/cli/src/main.rs on `ExitReason::Fatal`, which would
 * otherwise be lost when the TUI clears the screen on exit.
 */

const DEFAULT_MAX_BYTES = 64 * 1024;

export class StderrRingBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number = DEFAULT_MAX_BYTES) {
    if (maxBytes <= 0) {
      throw new Error("StderrRingBuffer maxBytes must be positive");
    }
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;

    // If the incoming chunk alone exceeds capacity, keep only its tail.
    if (chunk.length >= this.maxBytes) {
      this.chunks = [chunk.subarray(chunk.length - this.maxBytes)];
      this.bytes = this.maxBytes;
      return;
    }

    this.chunks.push(chunk);
    this.bytes += chunk.length;

    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const overflow = this.bytes - this.maxBytes;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.bytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.bytes -= overflow;
      }
    }
  }

  snapshot(): Buffer {
    return Buffer.concat(this.chunks, this.bytes);
  }

  toString(encoding: BufferEncoding = "utf-8"): string {
    return this.snapshot().toString(encoding);
  }

  get byteLength(): number {
    return this.bytes;
  }
}
