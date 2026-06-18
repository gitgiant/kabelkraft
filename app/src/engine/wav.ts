/** Minimal stereo WAV encoder for the Recorder (PRD §8.7): 16/24-bit PCM or 32-bit float. */

import type { BitDepth } from '../core/settings';

export function encodeWav(
  chL: Float32Array,
  chR: Float32Array,
  sampleRate: number,
  bitDepth: BitDepth = 16,
): Blob {
  const frames = chL.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = 2 * bytesPerSample; // stereo
  const dataBytes = frames * blockAlign;
  const isFloat = bitDepth === 32;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, isFloat ? 3 : 1, true); // 1 = PCM, 3 = IEEE float
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);

  const clamp = (x: number) => Math.max(-1, Math.min(1, x));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    const samples = [clamp(chL[i]), clamp(chR[i])];
    for (const s of samples) {
      if (isFloat) {
        view.setFloat32(offset, s, true);
        offset += 4;
      } else if (bitDepth === 24) {
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        view.setUint8(offset, v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
        offset += 3;
      } else {
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
