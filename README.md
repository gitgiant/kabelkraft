# KabelKraft

A modular audio playground in the browser: drag modules onto an infinite canvas,
wire them together, and build sounds, music, and visuals. In the lineage of
Pure Data, VCV Rack, and Bespoke Synth — with a friendlier learning curve,
first-class visual feedback, and (planned) AI-assisted patch building.

> Anyone can drag a synth onto the canvas, wire it to a sequencer, and hear
> sound within 60 seconds — and the same canvas scales to deep, layered patches.

## Status

Phase 1 complete (see [PRD.md](PRD.md) §17 for the roadmap):

- **Canvas & wiring** — pan/zoom, typed ports (audio / note / control / trigger /
  transport), drag-to-wire with snap, incompatible ports reject with a flash,
  wires pulse with the live signal
- **Modules (16)** — Master Transport, Sequencer, LFO, ADSR, Random, Synth
  (5 waveforms, ADSR, polyphonic), Sampler (load files, pitched playback),
  Keyboard (mouse + QWERTY), Delay, Reverb, Distortion, Simple EQ, Mixer,
  Recorder (bounce to WAV), Audio Out (safety limiter on by default), Levels
- **Module groups** — multi-select, group/collapse to a tile with proxy ports,
  expand in place, nesting; the audio engine never sees groups, so grouping
  never interrupts sound
- **Undo/redo**, **dark/light themes**, **interactive tutorial**,
  **save/load projects** (`.kkproj`, samples embedded)

## Run it

```sh
cd app
npm install
npm run dev
```

Open the printed URL (Chrome/Edge recommended), click **Enable Audio**, press
**Play** — the starter patch sequences a synth. Play the A-row of your keyboard.
Click **?** in the toolbar for the tutorial.

## Tests

```sh
cd app
npx vitest run          # core graph/serialization unit tests
npx playwright test     # end-to-end incl. headless audio assertions (uses system Chrome)
```

## Architecture (short version)

- **UI**: TypeScript + Svelte chrome + PixiJS (WebGL) patch canvas
- **Engine**: a single `AudioWorklet` ([app/public/engine-worklet.js](app/public/engine-worklet.js))
  owns the transport clock and the audio-relevant graph; the main thread mirrors
  the patch into it over a thin message protocol
- That protocol is the seam where a portable C++ DSP core (native + WASM)
  slots in for the planned VST3 and standalone builds via JUCE 8 WebView —
  see [PRD.md](PRD.md) §16 for the full stack decision

## License

TBD
