import { describe, expect, it } from 'vitest';
import { createVisRingBuffer, VIS_RING_CAPACITY, VisRingReader } from './ring';

/** Mirrors the worklet-side writer in public/engine-worklet.js. */
function makeWriter(sab: SharedArrayBuffer) {
  const head = new Int32Array(sab, 0, 1);
  const chL = new Float32Array(sab, 16, VIS_RING_CAPACITY);
  const chR = new Float32Array(sab, 16 + VIS_RING_CAPACITY * 4, VIS_RING_CAPACITY);
  let written = 0;
  return (l: number[], r: number[]) => {
    let w = written % VIS_RING_CAPACITY;
    for (let i = 0; i < l.length; i++) {
      chL[w] = l[i];
      chR[w] = r[i];
      w = (w + 1) % VIS_RING_CAPACITY;
    }
    written += l.length;
    Atomics.store(head, 0, written);
  };
}

describe('vis ring', () => {
  it('returns false until enough audio is written', () => {
    const reader = new VisRingReader(createVisRingBuffer());
    expect(reader.readLatest(new Float32Array(8), new Float32Array(8))).toBe(false);
  });

  it('reads the most recent window, newest sample last', () => {
    const sab = createVisRingBuffer();
    const write = makeWriter(sab);
    const reader = new VisRingReader(sab);
    write([1, 2, 3, 4, 5, 6], [-1, -2, -3, -4, -5, -6]);
    const outL = new Float32Array(4);
    const outR = new Float32Array(4);
    expect(reader.readLatest(outL, outR)).toBe(true);
    expect([...outL]).toEqual([3, 4, 5, 6]);
    expect([...outR]).toEqual([-3, -4, -5, -6]);
  });

  it('survives wraparound across the capacity boundary', () => {
    const sab = createVisRingBuffer();
    const write = makeWriter(sab);
    const reader = new VisRingReader(sab);
    // Fill to 3 samples short of capacity, then write 6 across the seam.
    const filler = VIS_RING_CAPACITY - 3;
    write(new Array(filler).fill(0), new Array(filler).fill(0));
    write([10, 11, 12, 13, 14, 15], [20, 21, 22, 23, 24, 25]);
    const outL = new Float32Array(6);
    const outR = new Float32Array(6);
    expect(reader.readLatest(outL, outR)).toBe(true);
    expect([...outL]).toEqual([10, 11, 12, 13, 14, 15]);
    expect([...outR]).toEqual([20, 21, 22, 23, 24, 25]);
  });
});
