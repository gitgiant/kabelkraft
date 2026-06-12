/**
 * UI-side audio analysis for the visual engine — VISUALIZER_ENGINE_PLAN.md.
 * The worklet ships raw windows only (SAB ring, or status-message fallback);
 * FFT/bands/centroid run here, once per rendered frame per container, so the
 * audio thread never pays for display analysis.
 */

import { VisRingReader } from './ring';
import { VIS_WINDOW, type VisFeatures } from './types';

export const SPECTRUM_BINS = 64;

// -- radix-2 FFT (mirrors the worklet's EQ FFT) -------------------------------

const fftRe = new Float32Array(VIS_WINDOW);
const fftIm = new Float32Array(VIS_WINDOW);
const hannWin = new Float32Array(VIS_WINDOW);
for (let i = 0; i < VIS_WINDOW; i++) hannWin[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / VIS_WINDOW);

function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j |= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

/** Log-spaced bin edge frequency (20 Hz – 20 kHz), b in 0..SPECTRUM_BINS. */
function binEdgeHz(b: number): number {
  return 20 * Math.pow(10, (3 * b) / SPECTRUM_BINS);
}

/**
 * 64 log-spaced magnitude bins in dB from a linear window (newest sample
 * last). Calibration matches the legacy worklet spectrum so migrated patches
 * look identical.
 */
export function computeSpectrum(window: Float32Array, sampleRate: number, out?: Float32Array): Float32Array {
  const result = out ?? new Float32Array(SPECTRUM_BINS);
  for (let i = 0; i < VIS_WINDOW; i++) {
    fftRe[i] = window[i] * hannWin[i];
    fftIm[i] = 0;
  }
  fftInPlace(fftRe, fftIm);
  const binHz = sampleRate / VIS_WINDOW;
  for (let b = 0; b < SPECTRUM_BINS; b++) {
    const i0 = Math.max(1, Math.floor(binEdgeHz(b) / binHz));
    const i1 = Math.min(VIS_WINDOW / 2 - 1, Math.max(i0, Math.ceil(binEdgeHz(b + 1) / binHz)));
    let peak = 0;
    for (let i = i0; i <= i1; i++) {
      const m = fftRe[i] * fftRe[i] + fftIm[i] * fftIm[i];
      if (m > peak) peak = m;
    }
    result[b] = 10 * Math.log10(peak / (VIS_WINDOW * VIS_WINDOW) + 1e-12) + 30;
  }
  return result;
}

/** dB bin → 0..1 display fraction (same mapping the legacy scenes used). */
export function binFrac(db: number): number {
  return Math.min(1, Math.max(0, (db + 80) / 80));
}

function bandEnergy(spectrum: Float32Array, loHz: number, hiHz: number): number {
  let peak = 0;
  for (let b = 0; b < SPECTRUM_BINS; b++) {
    const f = binEdgeHz(b);
    if (f < loHz) continue;
    if (f >= hiHz) break;
    peak = Math.max(peak, binFrac(spectrum[b]));
  }
  return peak;
}

// -- per-container feature state ----------------------------------------------

/** Worklet status payload per visualizer (windows only without a SAB ring). */
export interface VisStatusFeed {
  waveL?: number[];
  waveR?: number[];
  notes: number[];
  ctrl: number;
  onset: number;
}

class ContainerFeed {
  ring: VisRingReader | null = null;
  /** Fallback windows from the last status post (no SAB path). */
  fallbackL = new Float32Array(VIS_WINDOW);
  fallbackR = new Float32Array(VIS_WINDOW);
  hasFallback = false;
  pendingNotes: number[] = [];
  ctrl = -1;
  onset = 0;
  cached: VisFeatures | null = null;
  cachedAt = -1;
}

/**
 * Computes VisFeatures per container, at most once per rendered frame —
 * multiple consumers in the same frame (tile ticker + overlay loop) share
 * the cached object, which also makes note-draining single-shot per frame.
 */
export class VisFeatureHub {
  private feeds = new Map<string, ContainerFeed>();
  private sampleRate = 48000;

  setSampleRate(sr: number): void {
    this.sampleRate = sr;
  }

  private feed(moduleId: string): ContainerFeed {
    let f = this.feeds.get(moduleId);
    if (!f) {
      f = new ContainerFeed();
      this.feeds.set(moduleId, f);
    }
    return f;
  }

  attachRing(moduleId: string, sab: SharedArrayBuffer): void {
    this.feed(moduleId).ring = new VisRingReader(sab);
  }

  hasRing(moduleId: string): boolean {
    return this.feeds.get(moduleId)?.ring != null;
  }

  /** Stash the per-status payload (notes/ctrl/onset, plus windows sans SAB). */
  pushStatus(moduleId: string, data: VisStatusFeed): void {
    const f = this.feed(moduleId);
    f.pendingNotes.push(...data.notes);
    if (f.pendingNotes.length > 64) f.pendingNotes.splice(0, f.pendingNotes.length - 64);
    f.ctrl = data.ctrl;
    f.onset = Math.max(f.onset, data.onset);
    if (data.waveL && data.waveR && data.waveL.length === VIS_WINDOW) {
      f.fallbackL.set(data.waveL);
      f.fallbackR.set(data.waveR);
      f.hasFallback = true;
    }
  }

  /** Drop feeds for deleted modules. */
  prune(liveIds: ReadonlySet<string>): void {
    for (const id of [...this.feeds.keys()]) if (!liveIds.has(id)) this.feeds.delete(id);
  }

  /**
   * Current features for one container; null until audio arrives. `now` is
   * the caller's frame timestamp — calls within ~2 ms share the cache.
   */
  features(moduleId: string, now: number): VisFeatures | null {
    const f = this.feeds.get(moduleId);
    if (!f) return null;
    if (f.cached && now - f.cachedAt < 2) return f.cached;

    const waveL = new Float32Array(VIS_WINDOW);
    const waveR = new Float32Array(VIS_WINDOW);
    if (f.ring) {
      if (!f.ring.readLatest(waveL, waveR) && !f.hasFallback) return null;
    } else if (f.hasFallback) {
      waveL.set(f.fallbackL);
      waveR.set(f.fallbackR);
    } else {
      return null;
    }

    const wave = new Float32Array(VIS_WINDOW);
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < VIS_WINDOW; i++) {
      const v = (waveL[i] + waveR[i]) * 0.5;
      wave[i] = v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
    }
    const spectrum = computeSpectrum(wave, this.sampleRate);

    let fracSum = 0;
    let weighted = 0;
    for (let b = 0; b < SPECTRUM_BINS; b++) {
      const frac = binFrac(spectrum[b]);
      fracSum += frac;
      weighted += frac * (b / (SPECTRUM_BINS - 1));
    }

    const out: VisFeatures = {
      wave,
      waveL,
      waveR,
      spectrum,
      level: Math.sqrt(sumSq / VIS_WINDOW),
      peak,
      bands: {
        bass: bandEnergy(spectrum, 20, 250),
        mid: bandEnergy(spectrum, 250, 2000),
        high: bandEnergy(spectrum, 2000, 8000),
      },
      onset: f.onset,
      centroid: fracSum > 0 ? weighted / fracSum : 0,
      notes: f.pendingNotes,
      ctrl: f.ctrl,
    };
    f.pendingNotes = [];
    f.onset = 0;
    f.cached = out;
    f.cachedAt = now;
    return out;
  }
}
