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
}

export interface SerializedSample {
  moduleId: string;
  name: string;
  sampleRate: number;
  /** Base64-encoded little-endian float32 PCM per channel. */
  channels: string[];
}

export function encodeSample(moduleId: string, sample: SampleData): SerializedSample {
  return {
    moduleId,
    name: sample.name,
    sampleRate: sample.sampleRate,
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
    channels: raw.channels.map((b64) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Float32Array(bytes.buffer);
    }),
  };
}
