/**
 * Sample Editor operations (PRD §8.2) — pure functions over channel PCM.
 * Every op returns NEW Float32Arrays; the editor works on a copy and the
 * store is only touched on explicit save (non-destructive until then).
 */

export type Channels = Float32Array[];

/** Frame range, start inclusive, end exclusive. */
export interface Region {
  start: number;
  end: number;
}

function clampRegion(len: number, r: Region): Region {
  const start = Math.max(0, Math.min(len, Math.floor(Math.min(r.start, r.end))));
  const end = Math.max(0, Math.min(len, Math.ceil(Math.max(r.start, r.end))));
  return { start, end };
}

function wholeOr(len: number, r?: Region): Region {
  return r ? clampRegion(len, r) : { start: 0, end: len };
}

/** Keep only the region (crop). */
export function trim(channels: Channels, r: Region): Channels {
  const { start, end } = clampRegion(channels[0].length, r);
  return channels.map((c) => c.slice(start, end));
}

/** Delete the region, joining what surrounds it. */
export function remove(channels: Channels, r: Region): Channels {
  const { start, end } = clampRegion(channels[0].length, r);
  return channels.map((c) => {
    const out = new Float32Array(c.length - (end - start));
    out.set(c.subarray(0, start), 0);
    out.set(c.subarray(end), start);
    return out;
  });
}

export function copy(channels: Channels, r: Region): Channels {
  const { start, end } = clampRegion(channels[0].length, r);
  return channels.map((c) => c.slice(start, end));
}

/** Insert clip PCM at a frame position. Channel counts are reconciled. */
export function insert(channels: Channels, at: number, clip: Channels): Channels {
  const len = channels[0].length;
  const pos = Math.max(0, Math.min(len, Math.floor(at)));
  return channels.map((c, ci) => {
    // Mono clip into stereo target: reuse channel 0; stereo into mono: take channel 0.
    const src = clip[Math.min(ci, clip.length - 1)];
    const out = new Float32Array(c.length + src.length);
    out.set(c.subarray(0, pos), 0);
    out.set(src, pos);
    out.set(c.subarray(pos), pos + src.length);
    return out;
  });
}

/** Scale the region so its peak hits `peak` (whole sample when no region). */
export function normalize(channels: Channels, r?: Region, peak = 0.95): Channels {
  const { start, end } = wholeOr(channels[0].length, r);
  let max = 0;
  for (const c of channels) {
    for (let i = start; i < end; i++) max = Math.max(max, Math.abs(c[i]));
  }
  const gain = max > 0 ? peak / max : 1;
  return channels.map((c) => {
    const out = c.slice();
    for (let i = start; i < end; i++) out[i] *= gain;
    return out;
  });
}

export function reverse(channels: Channels, r?: Region): Channels {
  const { start, end } = wholeOr(channels[0].length, r);
  return channels.map((c) => {
    const out = c.slice();
    for (let i = start, j = end - 1; i < j; i++, j--) {
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  });
}

export function fadeIn(channels: Channels, r?: Region): Channels {
  const { start, end } = wholeOr(channels[0].length, r);
  const n = end - start;
  return channels.map((c) => {
    const out = c.slice();
    for (let i = 0; i < n; i++) out[start + i] *= i / n;
    return out;
  });
}

export function fadeOut(channels: Channels, r?: Region): Channels {
  const { start, end } = wholeOr(channels[0].length, r);
  const n = end - start;
  return channels.map((c) => {
    const out = c.slice();
    for (let i = 0; i < n; i++) out[start + i] *= 1 - (i + 1) / n;
    return out;
  });
}

/**
 * Pitch shift by resampling — length changes with pitch (tape-style).
 * Simple by design; formant-preserving shift waits for the C++ core.
 */
export function pitchShift(channels: Channels, semitones: number): Channels {
  const factor = Math.pow(2, semitones / 12); // playback speed
  const srcLen = channels[0].length;
  const outLen = Math.max(1, Math.round(srcLen / factor));
  return channels.map((c) => {
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * factor;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      out[i] = i0 + 1 < srcLen ? c[i0] * (1 - frac) + c[i0 + 1] * frac : (c[i0] ?? 0);
    }
    return out;
  });
}

/**
 * Time stretch without pitch change — overlap-add of Hann-windowed grains.
 * factor = output length / input length (0.5 = half as long, 2 = twice).
 */
export function timeStretch(channels: Channels, factor: number): Channels {
  const srcLen = channels[0].length;
  const grain = 2048; // ~46 ms at 44.1k
  const synHop = grain / 2; // 50% overlap: Hann windows sum to 1
  const anaHop = synHop / factor;
  const outLen = Math.max(1, Math.round(srcLen * factor));
  const win = new Float32Array(grain);
  for (let i = 0; i < grain; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / grain);

  return channels.map((c) => {
    const out = new Float32Array(outLen);
    const grains = Math.ceil(outLen / synHop);
    for (let g = 0; g < grains; g++) {
      const outPos = g * synHop;
      const srcPos = Math.min(Math.max(0, srcLen - grain), Math.round(g * anaHop));
      for (let i = 0; i < grain; i++) {
        const o = outPos + i;
        if (o >= outLen) break;
        out[o] += (c[srcPos + i] ?? 0) * win[i];
      }
    }
    return out;
  });
}

/**
 * Bake a loop-point crossfade: the tail leading into loopEnd is blended with
 * the material leading into loopStart, so the wrap-around is click-free.
 */
export function crossfadeLoop(
  channels: Channels,
  loopStart: number,
  loopEnd: number,
  fadeFrames: number,
): Channels {
  const len = channels[0].length;
  const ls = Math.max(0, Math.floor(loopStart));
  const le = Math.min(len, Math.floor(loopEnd));
  const fade = Math.min(Math.floor(fadeFrames), ls, le - ls);
  if (fade <= 0 || le <= ls) return channels.map((c) => c.slice());
  return channels.map((c) => {
    const out = c.slice();
    for (let i = 0; i < fade; i++) {
      const t = (i + 1) / fade; // equal-power blend
      const a = Math.cos((t * Math.PI) / 2);
      const b = Math.sin((t * Math.PI) / 2);
      out[le - fade + i] = c[le - fade + i] * a + c[ls - fade + i] * b;
    }
    return out;
  });
}
