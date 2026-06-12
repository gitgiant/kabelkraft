/**
 * SharedArrayBuffer audio ring — worklet writes stereo audio continuously,
 * the render thread pulls the latest window at its own rate. Rates fully
 * decoupled, no per-frame messages (VISUALIZER_ENGINE_PLAN.md).
 *
 * Layout (all little-endian, per visualizer module):
 *   [0..4)                       Int32  total frames written (Atomics)
 *   [16 .. 16+cap*4)             Float32 L ring
 *   [16+cap*4 .. 16+cap*8)       Float32 R ring
 *
 * The writer only advances the counter after the samples land, and capacity
 * (16384) dwarfs window (1024) + render block (128), so a reader copying the
 * region just below the counter never races the write head.
 *
 * The worklet-side writer lives in public/engine-worklet.js (plain JS) and
 * must mirror these offsets exactly.
 */

export const VIS_RING_CAPACITY = 16384;
const HEADER_BYTES = 16;

export function visRingByteLength(): number {
  return HEADER_BYTES + VIS_RING_CAPACITY * 2 * 4;
}

export function createVisRingBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(visRingByteLength());
}

export class VisRingReader {
  private readonly head: Int32Array;
  private readonly chL: Float32Array;
  private readonly chR: Float32Array;

  constructor(readonly sab: SharedArrayBuffer) {
    this.head = new Int32Array(sab, 0, 1);
    this.chL = new Float32Array(sab, HEADER_BYTES, VIS_RING_CAPACITY);
    this.chR = new Float32Array(sab, HEADER_BYTES + VIS_RING_CAPACITY * 4, VIS_RING_CAPACITY);
  }

  /** Total frames the worklet has written so far. */
  get framesWritten(): number {
    return Atomics.load(this.head, 0);
  }

  /**
   * Copy the most recent `outL.length` frames (newest last). Returns false —
   * leaving the buffers untouched — until enough audio has been written.
   */
  readLatest(outL: Float32Array, outR: Float32Array): boolean {
    const n = outL.length;
    const written = Atomics.load(this.head, 0);
    if (written < n) return false;
    let src = (written - n) % VIS_RING_CAPACITY;
    for (let i = 0; i < n; i++) {
      outL[i] = this.chL[src];
      outR[i] = this.chR[src];
      src = (src + 1) % VIS_RING_CAPACITY;
    }
    return true;
  }
}
