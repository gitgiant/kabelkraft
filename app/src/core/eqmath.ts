/**
 * RBJ biquad coefficient math, main-thread copy for the Parametric EQ curve
 * display. Mirrors the worklet's Biquad — keep the two in sync (the seam the
 * C++ core later replaces on both sides at once).
 */

export interface BiquadCoefs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Band types match PEQ_BAND_TYPES in the registry. */
export type PeqBandType = 0 | 1 | 2 | 3 | 4; // peak, lo-shelf, hi-shelf, lo-cut, hi-cut

function norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoefs {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function bandCoefs(
  type: PeqBandType,
  freq: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): BiquadCoefs {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.49)) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);

  if (type === 0) {
    const alpha = sin / (2 * q);
    return norm(1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A);
  }
  if (type === 1 || type === 2) {
    const alpha = (sin / 2) * Math.SQRT2;
    const sA = 2 * Math.sqrt(A) * alpha;
    if (type === 1) {
      return norm(
        A * (A + 1 - (A - 1) * cos + sA),
        2 * A * (A - 1 - (A + 1) * cos),
        A * (A + 1 - (A - 1) * cos - sA),
        A + 1 + (A - 1) * cos + sA,
        -2 * (A - 1 + (A + 1) * cos),
        A + 1 + (A - 1) * cos - sA,
      );
    }
    return norm(
      A * (A + 1 + (A - 1) * cos + sA),
      -2 * A * (A - 1 + (A + 1) * cos),
      A * (A + 1 + (A - 1) * cos - sA),
      A + 1 - (A - 1) * cos + sA,
      2 * (A - 1 - (A + 1) * cos),
      A + 1 - (A - 1) * cos - sA,
    );
  }
  const alpha = sin / (2 * q);
  if (type === 3) {
    // lo-cut = highpass
    return norm((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
  }
  // hi-cut = lowpass
  return norm((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

/**
 * RBJ coefficients matching the Filter (vcf) component's modes, for its
 * response-curve display. The worklet runs a Chamberlin SVF, not a biquad —
 * close enough visually; res maps to Q via the SVF damping (q = 1/(2(1-res))).
 */
export function vcfCoefs(
  mode: number, // 0 lowpass, 1 highpass, 2 bandpass, 3 notch
  freq: number,
  res: number,
  sampleRate: number,
): BiquadCoefs {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.49)) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const q = 1 / (2 * (1 - Math.min(0.95, Math.max(0, res))));
  const alpha = sin / (2 * q);
  if (mode === 0) {
    return norm((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
  }
  if (mode === 1) {
    return norm((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
  }
  if (mode === 2) {
    return norm(alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha);
  }
  return norm(1, -2 * cos, 1, 1 + alpha, -2 * cos, 1 - alpha);
}

/** Magnitude (dB) of one biquad at frequency f. */
export function biquadResponseDb(c: BiquadCoefs, f: number, sampleRate: number): number {
  const w = (2 * Math.PI * f) / sampleRate;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const num =
    c.b0 * c.b0 + c.b1 * c.b1 + c.b2 * c.b2 + 2 * (c.b0 * c.b1 + c.b1 * c.b2) * cw + 2 * c.b0 * c.b2 * c2w;
  const den = 1 + c.a1 * c.a1 + c.a2 * c.a2 + 2 * (c.a1 + c.a1 * c.a2) * cw + 2 * c.a2 * c2w;
  return 10 * Math.log10(Math.max(1e-12, num / Math.max(1e-12, den)));
}

/** Combined response of a band chain at frequency f. */
export function chainResponseDb(bands: BiquadCoefs[], f: number, sampleRate: number): number {
  let db = 0;
  for (const b of bands) db += biquadResponseDb(b, f, sampleRate);
  return db;
}
