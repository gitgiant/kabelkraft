/**
 * Text to Speech synthesis driver (TTS_PLAN.md).
 *
 * `synthesizeSpeech` turns text into mono PCM that state.ts wraps as SampleData
 * and plays through the sampler voice engine. Synthesis runs on piper-plus
 * (MIT) + its rule-based G2P (MIT, no espeak/GPL) over onnxruntime-web. Both
 * are dynamically imported so they (and their WASM) stay out of the initial
 * bundle and only load when TTS is first used.
 *
 * piper-plus downloads and IndexedDB-caches each model itself; one PiperPlus
 * instance per model is reused across voices that share it (the multilingual
 * base model backs several languages).
 *
 * Until production voice models are hosted + license-vetted, a synthesis
 * failure degrades to a placeholder formant tone so the module stays usable in
 * dev. Remove the fallback once models ship (P5).
 */

import type { ProgressInfo } from 'piper-plus';
import { voiceById, type TtsVoice } from './voices';

export interface SynthesizedSpeech {
  sampleRate: number;
  channels: Float32Array[];
}

/** Coarse init/download progress: a human message + 0..1 fraction. */
export type SynthProgress = (message: string, fraction: number) => void;

// onnxruntime-web, loaded once and configured for WASM asset resolution.
let ortPromise: Promise<typeof import('onnxruntime-web')> | null = null;
function loadOrt(): Promise<typeof import('onnxruntime-web')> {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web').then((ort) => {
      // CDN default keeps dev working. For the offline/proprietary build, copy
      // node_modules/onnxruntime-web/dist/*.wasm into public/ort/ and set
      // ort.env.wasm.wasmPaths = '/ort/'.
      try {
        const v = (ort as unknown as { env: { versions?: { web?: string } } }).env.versions?.web;
        ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${v ?? ''}/dist/`;
      } catch {
        /* leave ORT defaults */
      }
      return ort;
    });
  }
  return ortPromise;
}

// One PiperPlus instance per model (shared across same-model voices).
const instances = new Map<string, Promise<import('piper-plus').PiperPlus>>();

function getPiper(voice: TtsVoice, onProgress?: SynthProgress): Promise<import('piper-plus').PiperPlus> {
  let inst = instances.get(voice.model);
  if (!inst) {
    inst = (async () => {
      const [{ PiperPlus }, ort] = await Promise.all([import('piper-plus'), loadOrt()]);
      return PiperPlus.initialize({
        model: voice.model,
        ort,
        onProgress: (info: ProgressInfo) => onProgress?.(info.message ?? info.stage, info.progress ?? 0),
      });
    })();
    instances.set(voice.model, inst);
  }
  return inst;
}

/**
 * Synthesize `text` with the given voice at `speed` (our 0.5..2, higher =
 * faster → Piper length_scale = 1/speed). Returns mono PCM at the model's
 * native rate (the worklet resamples to the audio context rate).
 */
export async function synthesizeSpeech(
  text: string,
  voiceId: string,
  speed = 1,
  onProgress?: SynthProgress,
): Promise<SynthesizedSpeech> {
  const clean = text.trim();
  if (!clean) throw new Error('Nothing to speak');
  const voice = voiceById(voiceId);
  if (!voice) throw new Error(`Unknown voice: ${voiceId || '(none)'}`);

  try {
    const piper = await getPiper(voice, onProgress);
    const audio = await piper.synthesize(clean, {
      language: voice.lang,
      lengthScale: 1 / Math.max(0.25, speed),
    });
    return { sampleRate: audio.sampleRate, channels: [audio.samples] };
  } catch (e) {
    // Drop the failed instance so a later attempt re-initializes cleanly, then
    // fall back to the placeholder so dev stays usable before models are hosted.
    instances.delete(voice.model);
    console.warn('[tts] piper-plus synthesis failed; using placeholder tone:', e);
    return placeholderSpeech(clean, speed);
  }
}

/** Vaguely-vocal robotic tone, scaled by text length — dev fallback only. */
function placeholderSpeech(clean: string, speed: number): SynthesizedSpeech {
  const sampleRate = 22050;
  const perChar = 0.06 / Math.max(0.5, speed);
  const dur = Math.min(20, Math.max(0.3, clean.length * perChar));
  const n = Math.floor(dur * sampleRate);
  const pcm = new Float32Array(n);
  const f0 = 110;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const ch = clean.charCodeAt(Math.floor((i / n) * clean.length) % clean.length);
    const wobble = 1 + 0.15 * Math.sin(2 * Math.PI * 5 * t);
    const formant = 1 + (ch % 8) * 0.25;
    const s =
      0.6 * Math.sin(2 * Math.PI * f0 * wobble * t) +
      0.3 * Math.sin(2 * Math.PI * f0 * formant * 2 * t) +
      0.1 * (Math.random() * 2 - 1);
    const syl = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    pcm[i] = s * syl * 0.4;
  }
  const fade = Math.min(512, Math.floor(n / 8));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    pcm[i] *= g;
    pcm[n - 1 - i] *= g;
  }
  return { sampleRate, channels: [pcm] };
}
