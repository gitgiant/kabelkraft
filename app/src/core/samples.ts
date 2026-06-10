/**
 * Sample storage, kept OUTSIDE the graph JSON on purpose: undo snapshots
 * serialize the graph on every step, and raw PCM there would copy megabytes
 * per edit. Samples are keyed by the owning module id and only embedded
 * (base64) when the user explicitly saves the project (PRD §15).
 */

export interface SampleData {
  name: string;
  sampleRate: number;
  /** 1 (mono) or 2 (stereo) channels of PCM. */
  channels: Float32Array[];
  /** Loop region in frames (Sample Editor); absent = loop the whole sample. */
  loopStart?: number;
  loopEnd?: number;
}

export interface SerializedSample {
  moduleId: string;
  /** Drum machine pad index; absent for single-sample modules (sampler). */
  pad?: number;
  name: string;
  sampleRate: number;
  loopStart?: number;
  loopEnd?: number;
  /** Base64-encoded little-endian float32 PCM per channel. */
  channels: string[];
}

/**
 * Store key for the samples map: plain module id for single-sample modules,
 * `moduleId#pad` for drum machine pads ('#' never appears in module ids).
 */
export function sampleKey(moduleId: string, pad?: number): string {
  return pad === undefined ? moduleId : `${moduleId}#${pad}`;
}

export function parseSampleKey(key: string): { moduleId: string; pad?: number } {
  const i = key.indexOf('#');
  if (i < 0) return { moduleId: key };
  return { moduleId: key.slice(0, i), pad: Number(key.slice(i + 1)) };
}

export function encodeSample(moduleId: string, sample: SampleData, pad?: number): SerializedSample {
  return {
    moduleId,
    pad,
    name: sample.name,
    sampleRate: sample.sampleRate,
    loopStart: sample.loopStart,
    loopEnd: sample.loopEnd,
    channels: sample.channels.map((ch) => {
      const bytes = new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      return btoa(binary);
    }),
  };
}

export function decodeSample(raw: SerializedSample): SampleData {
  return {
    name: raw.name,
    sampleRate: raw.sampleRate,
    loopStart: raw.loopStart,
    loopEnd: raw.loopEnd,
    channels: raw.channels.map((b64) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Float32Array(bytes.buffer);
    }),
  };
}
