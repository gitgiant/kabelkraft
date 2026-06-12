import { describe, expect, it } from 'vitest';
import { binFrac, computeSpectrum, SPECTRUM_BINS, VisFeatureHub } from './features';
import { createVisRingBuffer, VIS_RING_CAPACITY } from './ring';
import { VIS_WINDOW } from './types';

const SR = 48000;

function sine(freq: number, amp = 0.8): Float32Array {
  const out = new Float32Array(VIS_WINDOW);
  for (let i = 0; i < VIS_WINDOW; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

/** Log-bin index (20 Hz – 20 kHz over SPECTRUM_BINS) containing freq. */
function binOf(freq: number): number {
  return Math.floor((SPECTRUM_BINS * Math.log10(freq / 20)) / 3);
}

describe('computeSpectrum', () => {
  it('energy lands in the log bin holding the sine frequency', () => {
    // Low log bins share FFT bins (1024-sample window), so assert the
    // expected bin carries near-max energy rather than exact peak position.
    for (const freq of [440, 2000, 8000]) {
      const spectrum = computeSpectrum(sine(freq), SR);
      const max = Math.max(...spectrum);
      expect(spectrum[binOf(freq)]).toBeGreaterThan(max - 3); // within 3 dB
      // And far-away bins are clearly quieter.
      const far = binOf(freq) + 16;
      if (far < SPECTRUM_BINS) expect(spectrum[far]).toBeLessThan(max - 12);
    }
  });

  it('reports near-silence for an all-zero window', () => {
    const spectrum = computeSpectrum(new Float32Array(VIS_WINDOW), SR);
    for (let b = 0; b < SPECTRUM_BINS; b++) expect(binFrac(spectrum[b])).toBeLessThan(0.05);
  });
});

describe('VisFeatureHub', () => {
  it('computes features from fallback windows (no SAB)', () => {
    const hub = new VisFeatureHub();
    hub.setSampleRate(SR);
    const wave = sine(440);
    hub.pushStatus('m1', { waveL: [...wave], waveR: [...wave], notes: [60, 64], ctrl: 0.5, onset: 0.7 });
    const f = hub.features('m1', 0)!;
    expect(f).not.toBeNull();
    expect(f.level).toBeGreaterThan(0.3);
    expect(f.peak).toBeCloseTo(0.8, 1);
    expect(f.ctrl).toBe(0.5);
    expect(f.onset).toBe(0.7);
    expect(f.notes).toEqual([60, 64]);
    expect(f.bands.mid).toBeGreaterThan(f.bands.high);
  });

  it('drains notes and onset once per frame; caches within a frame', () => {
    const hub = new VisFeatureHub();
    hub.setSampleRate(SR);
    const wave = sine(440);
    hub.pushStatus('m1', { waveL: [...wave], waveR: [...wave], notes: [60], ctrl: -1, onset: 1 });
    const first = hub.features('m1', 100)!;
    expect(hub.features('m1', 101)).toBe(first); // same frame → cached
    const next = hub.features('m1', 200)!; // new frame → drained
    expect(next.notes).toEqual([]);
    expect(next.onset).toBe(0);
  });

  it('reads windows from a SAB ring when attached', () => {
    const hub = new VisFeatureHub();
    hub.setSampleRate(SR);
    const sab = createVisRingBuffer();
    const head = new Int32Array(sab, 0, 1);
    const chL = new Float32Array(sab, 16, VIS_RING_CAPACITY);
    const chR = new Float32Array(sab, 16 + VIS_RING_CAPACITY * 4, VIS_RING_CAPACITY);
    const wave = sine(440);
    chL.set(wave, 0);
    chR.set(wave, 0);
    Atomics.store(head, 0, VIS_WINDOW);
    hub.attachRing('m1', sab);
    hub.pushStatus('m1', { notes: [], ctrl: -1, onset: 0 });
    const f = hub.features('m1', 0)!;
    expect(f.level).toBeGreaterThan(0.3);
    expect(f.waveL[VIS_WINDOW - 1]).toBeCloseTo(wave[VIS_WINDOW - 1], 5);
  });

  it('text events feed the live line and karaoke stack', () => {
    const hub = new VisFeatureHub();
    hub.setSampleRate(SR);
    hub.pushText('m1', 'hello wor', false); // interim
    let f = hub.features('m1', 0)!;
    expect(f).not.toBeNull(); // text-only container still gets features
    expect(f.text).toBe('hello wor');
    expect(f.textStack).toEqual([]);
    expect(f.level).toBe(0); // silent audio
    hub.pushText('m1', 'hello world', true); // final — reaches cached frame too
    f = hub.features('m1', 1)!;
    expect(f.text).toBe('hello world');
    expect(f.textStack).toEqual(['hello world']);
    for (let i = 0; i < 10; i++) hub.pushText('m1', `line ${i}`, true);
    f = hub.features('m1', 100)!;
    expect(f.textStack.length).toBe(8); // capped
    expect(f.textStack[7]).toBe('line 9');
  });

  it('returns null with no feed, and prunes deleted modules', () => {
    const hub = new VisFeatureHub();
    expect(hub.features('nope', 0)).toBeNull();
    hub.pushStatus('m1', { notes: [], ctrl: -1, onset: 0 });
    hub.prune(new Set());
    expect(hub.hasRing('m1')).toBe(false);
  });
});
