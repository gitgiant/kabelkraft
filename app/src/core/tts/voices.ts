/**
 * Voice catalog for the Text to Speech module (TTS_PLAN.md).
 *
 * Synthesis runs through piper-plus (MIT) + @piper-plus/g2p (MIT, rule-based,
 * NO espeak/GPL) on onnxruntime-web. piper-plus downloads + IndexedDB-caches
 * the model itself, so entries only carry metadata + a model identifier.
 *
 * `model` is either a HuggingFace repo (works out of the box, good for dev) or
 * a self-hosted ONNX URL with its config at `<url>.json` (production — the
 * proprietary/offline path; see [[licensing-monetization]]).
 *
 * The piper-plus ENGINE + bundled phonemizers are MIT/BSD-3-Clause. The VOICE
 * MODEL each entry points at has its OWN license — `license` below must be
 * verified per model before commercial ship (CC0 / CC-BY ok; no NC).
 */

/** Languages piper-plus can phonemize (its `Language` union). */
export type TtsLang = 'en' | 'es' | 'fr' | 'pt' | 'ja' | 'zh' | 'ko' | 'sv';

export interface TtsVoice {
  /** Stable id stored in the module's data blob. */
  id: string;
  /** Display name in the voice dropdown. */
  name: string;
  /** Human accent/region label. */
  accent: string;
  /** piper-plus phonemization language. */
  lang: TtsLang;
  /** HF repo name OR self-hosted ONNX URL (config expected at `<url>.json`). */
  model: string;
  /** VOICE-MODEL license — verify before commercial ship. */
  license: string;
  /** Attribution string (THIRD_PARTY) when the model license requires it. */
  attribution?: string;
}

/**
 * Starter catalog.
 *
 * REALITY CHECK (verified against HuggingFace + runtime, 2026-06-18):
 *   - `piper-plus-base` is config-only — NO `.onnx`, fails to resolve.
 *   - `piper-plus-tsukuyomi-chan` and `piper-plus-css10-ja-6lang` DO ship an
 *     `.onnx` and are 6-language (ja/en/zh/es/fr/pt), but BOTH are
 *     voice-cloning architectures: their ONNX requires a `speaker_embedding`
 *     input that piper-plus's plain `synthesize()` never supplies, so inference
 *     throws "input 'speaker_embedding' is missing in 'feeds'". (The package's
 *     README `synthesize()` examples do not work with its own published models
 *     at v0.6.0.) No default embedding ships in the repos.
 *
 * NET: there is currently NO turnkey piper-plus model that produces speech via
 * the simple path. Until one of the following lands, `synthesizeSpeech` falls
 * back to the placeholder tone (tts.ts):
 *   A. Voice-cloning path — SpeakerEncoder.encode(reference wav) → embedding →
 *      synthesizeWithVoiceCloning (the repos ship sample_*.wav clips). Heavier;
 *      ja/zh also need the Rust-WASM G2P, whose asset path 404s under Vite.
 *   B. A standard single-speaker piper-plus voice (no speaker_embedding input),
 *      trained with piper-plus's G2P on a permissive (CC0/CC-BY) dataset and
 *      self-hosted (`model` = your URL, config at `<url>.json`). Best for a
 *      commercial English/accent product. See TTS_PLAN.md.
 *
 * The model below is wired for when a working one is dropped in; today it
 * downloads + runs ORT but inference rejects it (→ placeholder).
 */
const MODEL = 'ayousanz/piper-plus-css10-ja-6lang';
const MODEL_LICENSE = 'other — needs voice-cloning + license review; not commercial-ready';

export const TTS_VOICES: TtsVoice[] = [
  { id: 'pp-en', name: 'Voice', accent: 'English', lang: 'en', model: MODEL, license: MODEL_LICENSE },
  { id: 'pp-es', name: 'Voice', accent: 'Español', lang: 'es', model: MODEL, license: MODEL_LICENSE },
  { id: 'pp-fr', name: 'Voice', accent: 'Français', lang: 'fr', model: MODEL, license: MODEL_LICENSE },
  { id: 'pp-pt', name: 'Voice', accent: 'Português', lang: 'pt', model: MODEL, license: MODEL_LICENSE },
  { id: 'pp-ja', name: 'Voice', accent: '日本語', lang: 'ja', model: MODEL, license: MODEL_LICENSE },
];

export const DEFAULT_VOICE_ID = TTS_VOICES[0].id;

export function voiceById(id: string): TtsVoice | undefined {
  return TTS_VOICES.find((v) => v.id === id);
}
