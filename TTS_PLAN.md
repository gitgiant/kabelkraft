# TTS Module Plan

Text-to-speech module: type text → speak it, transposable/triggerable as a real
instrument in the modular graph, with selectable voices/accents. Local neural
synthesis (Piper), routable PCM through the audio graph.

## STATUS (2026-06-18) — branch `feat/tts-module`, uncommitted

**Shipped + browser-verified:** the `tts` module is fully wired and works as a
modular instrument — place it, type text, Generate → buffer, Speak / note input
→ audio routed through the graph (verified to a meter, peak ~0.28), karaoke text
out, ADSR/pitch/speed/level controls, project save skips the regenerable PCM.
tsc clean · build OK · 276 unit tests · svelte-check 0 errors.

**Blocked — no real neural voice yet (upstream limitation):** synthesis is wired
through piper-plus (MIT) + its rule-based JS G2P (MIT, no espeak/GPL) over
onnxruntime-web, dynamically imported/code-split. The integration is proven all
the way to the ONNX inference feed, BUT **no published piper-plus model works via
the documented `synthesize()` API** at v0.6.0: `piper-plus-base` has no `.onnx`;
`tsukuyomi-chan` + `css10-ja-6lang` are voice-cloning models that require a
`speaker_embedding` the package never supplies. So `synthesizeSpeech` currently
**falls back to a placeholder formant tone** (clearly logged). See "Verification
findings" + "Remaining before commercial ship" below.

**To resume → get a working voice:** Path A (voice-cloning: SpeakerEncoder +
shipped `sample_*.wav` → `synthesizeWithVoiceCloning`, + fix the Rust-WASM 404)
for quick dev audio, or Path B (train/host a standard single-speaker piper-plus
voice on a CC0/CC-BY dataset, no `speaker_embedding`) for the commercial product.
Single swap-point: the `MODEL` const in `src/core/tts/voices.ts`.

**Deps added:** `onnxruntime-web` (MIT), `piper-plus` (MIT; bundles BSD-3-Clause
OpenJTalk/jpreprocess). Add to THIRD_PARTY when shipping. **Code map:**
`src/core/tts/{tts,voices}.ts`, `src/canvas/faces/tts.ts`; edits to
`core/registry.ts`, `state.ts`, `engine/{engine,messages}.ts`,
`public/engine-worklet.js` (`TtsModule extends SmplModule`), `canvas/ModuleView.ts`.

## Decisions (grilled 2026-06-18)

- **Engine:** local neural TTS — Piper `.onnx` voices run via **onnxruntime-web**
  (MIT) in a **Web Worker** (never the audioworklet). Produces mono PCM Float32.
  Web Speech API rejected: speaks to speakers only, cannot enter the audio graph.
- **Phonemizer / G2P:** **piper-plus** G2P (MIT, no espeak-ng). Stock Piper uses
  espeak-ng (**GPL-3.0**) — a copyleft landmine for our closed-source proprietary
  product, so avoided. onnxruntime-web is MIT; the GPL'd Piper C++ engine is NOT
  linked (we run the ONNX model directly).
- **Voices:** ship/host only **CC0 or CC-BY** voices. CC-BY → attribution in
  THIRD_PARTY. No NC voices. Each voice's dataset license verified before adding.
- **Playback:** reuse the `smpl` (SmplModule) voice engine. Speak button triggers
  at root pitch; note input transposes + triggers (robot/talkbox), polyphonic,
  ADSR. PCM delivered via the existing `SampleMessage` path.
- **Synthesis timing:** explicit **Generate** button. text → Generate → worker
  synth → buffer cached as SampleData → Speak/notes play instantly. No surprise
  latency mid-performance. Regen on voice/speed change (they affect synthesis).
- **Voice delivery:** self-hosted `/models/piper/<voice>.{onnx,json}`, on-demand
  fetch with progress, cached in a persistent **`tts-voices` IndexedDB** store
  (survives across projects; distinct from per-module samples). Nothing bundled.
- **Save:** store `text` + `voiceId` + params only; **do NOT embed PCM** (it's
  regenerable). On load, module shows text "ungenerated" → user hits Generate
  (model must be cached). Keeps project files small.
- **Karaoke:** on speak, emit text via the existing text-pole `pushText` path →
  wire a text-pole output into a Visualizer container for subtitles.
- **Speed** = synthesis-time (Piper `length_scale`, natural). **Pitch** = playback
  transpose (real-time, no regen). Expressiveness knobs (noise_scale/noise_w)
  deferred past v1.

## Module shape

- **Type:** `tts`. Category `generator`.
- **Ports:** note in (trigger + transpose) · audio out (stereo) · text-pole out.
- **Params (numbers):** `level`, `attack`, `decay`, `sustain`, `release`, `root`,
  `fixedPitch`, `voices`, `pitch` (playback transpose), `speed` (length_scale,
  synth-time).
- **Data blob:** `text` (multiline), `voiceId`, `sampleName` (auto label),
  `generated` (bool — has a current buffer for the live text/voice/speed).
- **Face:** text field + voice/accent dropdown + Generate + Speak buttons; knobs
  level/speed/pitch. ADSR on advanced/expanded face.

## Pipeline

1. UI: type text, pick voice, Generate.
2. Ensure voice model: check `tts-voices` IndexedDB → else fetch from origin with
   progress → cache.
3. Web Worker: piper-plus G2P (text → phoneme ids) → onnxruntime-web infer →
   mono PCM @ model rate (usually 22050).
4. Wrap as `SampleData` (name = text snippet) → `state.setSample` → existing
   `engine.sendSample` → `tts` worklet module plays via smpl-style voices
   (resample handled by `sample.sampleRate / sampleRate`, pitch via rate).
5. On Speak/trigger: also emit text down the text-pole out (karaoke).

## Build phases

- **P1 — module skeleton:** DONE. `tts` in `EngineModuleType` + `ENGINE_MODULE_TYPES`;
  registry def; worklet `TtsModule extends SmplModule`; `TtsFace` (voice cycle,
  text edit, Generate/Speak, status); state `generateTts`/`speakTts`/`setTtsText`/
  `setTtsVoice` + karaoke emit; save skips TTS PCM. Placeholder formant synth in
  `tts/tts.ts` so the whole path is exercisable.
- **P2 — voice fetch + cache:** SUPERSEDED by P3. Built a `tts-voices`
  IndexedDB `voiceCache.ts`, then removed it — **piper-plus owns model download
  + IndexedDB caching + progress**, so a hand-rolled cache was redundant. The
  on-demand-fetch + persistent-cache requirement is met by piper-plus.
- **P3 — real synthesis:** DONE (not browser-verified offline). Integrated
  **piper-plus** (MIT) + its rule-based G2P (`SimpleEnglishPhonemizer`, MIT, NO
  espeak/GPL) over **onnxruntime-web**, both **dynamically imported** so they +
  their WASM code-split out of the initial bundle. `tts/tts.ts`: one PiperPlus
  instance per model (shared across same-model voices), `synthesize(text,
  {language, lengthScale=1/speed})` → `{sampleRate, channels:[samples]}`. Init
  progress piped to the face. Placeholder formant kept as a dev fallback on
  failure (removed in P5). `voices.ts` now lists piper-plus models — the base
  multilingual model backs EN/ES/FR/PT from one download (HF-hosted for dev).
  ORT WASM via jsdelivr CDN default (self-host for offline/prod).
- **P3 — synthesis worker:** `tts/piperWorker.ts` (onnxruntime-web + piper-plus
  G2P); `tts/tts.ts` main-thread driver (load model, synth, return Float32).
  Wire Generate button → driver → setSample.
- **P4 — text-pole karaoke:** emit spoken text via pushText on trigger.
- **P5 — polish + tests:** e2e (fake/short voice fixture), progress UI, error
  states (model missing on load), THIRD_PARTY attributions, licenses doc.

## Verification findings (2026-06-18, runtime e2e)

Module mechanics PASS: place → setTtsText → generateTts → buffer cached →
speakTts/note triggers → audio through graph to a meter (peak ~0.28), face
renders, zero console errors. BUT real piper-plus synthesis does **not** run:

- `ayousanz/piper-plus-base` = config-only, no `.onnx` (original 404).
- `tsukuyomi-chan` + `css10-ja-6lang` ship `.onnx` (6-lang) but are
  voice-cloning models — ONNX requires a `speaker_embedding` input that
  piper-plus `synthesize()` never supplies → `input 'speaker_embedding' is
  missing in 'feeds'`. README's simple examples don't work with the published
  models at v0.6.0. No default embedding in the repos.
- Rust-WASM G2P (ja/zh) 404s under Vite (`/node_modules/dist/rust-wasm/...`) —
  the `import.meta.url` asset path. English uses the JS phonemizer so this is
  non-fatal for EN, but ja/zh need it fixed.

Conclusion: clean MIT/BSD engine + G2P confirmed, integration proven to the ORT
feed, but NO turnkey piper-plus voice works. Real speech needs option A or B
below. Until then the placeholder tone plays.

## Remaining before commercial ship (P3 follow-ups + P5)

- **Get a working voice (BLOCKER for real audio):** either
  **A.** implement the voice-cloning path — `SpeakerEncoder.encode(reference
  wav)` → embedding → `synthesizeWithVoiceCloning` (repos ship `sample_*.wav`);
  also fix the Rust-WASM asset 404 for ja/zh — OR **B.** train/convert a
  standard single-speaker piper-plus voice (no speaker_embedding) on a CC0/CC-BY
  dataset and self-host. B is the right commercial path.

- **Browser verification:** run the app, confirm piper-plus WASM phonemizer
  asset resolves (build warned its `new URL('../../assets/', import.meta.url)`
  stays runtime-resolved) and a real voice synthesizes + routes through the
  graph. Cannot be checked offline/headless.
- **Self-host for offline/proprietary:** copy onnxruntime-web `dist/*.wasm` to
  `public/ort/` + set `ort.env.wasm.wasmPaths='/ort/'`; host piper-plus model
  files + its phonemizer WASM on our origin; switch `voices.ts` `model` from HF
  repos to self-hosted URLs.
- **License vetting (BLOCKER for commercial):** engine + bundled phonemizers
  are MIT/BSD-3-Clause (OpenJTalk, jpreprocess) — clean. But each VOICE MODEL
  (`ayousanz/piper-plus-base`, etc.) has its OWN license — currently marked
  `verify` in `voices.ts`. Confirm CC0/CC-BY (no NC) per model before shipping;
  add CC-BY attributions to THIRD_PARTY.
- **Voice curation:** real per-accent English/other voices + quality pass;
  speaker selection for the multi-speaker base model if desired.

## Open / later

- Optional cloud TTS backend (reuse AiImport provider-key infra) for premium
  voices — separate, post-v1.
- Optional control "trigger" input (sequencer-fired phrases) — note-in covers v1.
- Word-level karaoke timing (Piper can emit alignments) — v1 is whole-phrase.
