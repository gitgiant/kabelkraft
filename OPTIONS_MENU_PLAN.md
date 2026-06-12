# Options Menu Plan

**Status: SHIPPED — all 3 phases, 2026-06-12.**

Decided 2026-06-12 via grilling session. One tabbed modal dialog (⚙ in toolbar,
Cmd/Ctrl+,) holding all settings — global (localStorage) and per-project
(.kkproj) — with the per-project tab visually badged "saved with project".

## Architecture

- **`core/settings.ts`** — unified typed settings store. One versioned
  localStorage key, sections per tab (audio / midi / display / general),
  change events. **Migrate theme.ts and aiprovider.ts storage into it**
  (one-time migration from their old keys; modules keep their APIs, backed by
  the store).
- **`ui/OptionsDialog.svelte`** — modal shell + tab strip. Opened via toolbar ⚙
  or Cmd/Ctrl+, . Tabs: Project, Audio, MIDI, Display, AI, General, Shortcuts,
  Debug.
- Settings that don't exist yet get honest scope: no canvas rendering options
  tab section (nothing toggleable exists in PatchCanvas — revisit when canvas
  grows features).

## Tabs

### Project (per-project, serialized in .kkproj)
- Name (mirrors toolbar field), BPM (mirrors transport), time signature,
  artists, description, picture.
- **Time signature: metadata + display only.** Stored, shown in transporttext /
  piano-roll ruler where cheap. No engine/composer bar-math — that's a separate
  plan if ever.
- Picture: downscaled (~512px JPEG data URL) so .kkproj stays portable.

### Audio
- **Output device picker** — `enumerateDevices` + `AudioContext.setSinkId`;
  Chrome/Edge only, hidden elsewhere.
- **Latency hint** — interactive / balanced / playback; shows measured
  baseLatency/outputLatency read-only.
- **Sample rate** — request 44.1/48k at construction. Verify worklet DSP reads
  ctx rate everywhere before exposing.
- **Master volume + mute** — new global GainNode before destination. Persisted
  globally (device-level concern, not in project).
- **Restart semantics: apply immediately, auto-restart engine** preserving
  transport position + re-pushing samples. Brief dropout accepted.

### MIDI
- Device list (in/out) with live activity blink.
- **Mapping manager** — table of MIDI-learn CC→param bindings, delete /
  clear-all (today bindings are invisible; only fix is re-learn).
- Per-device enable toggle — disabled-ID set, **global localStorage** (device
  IDs are machine-specific; projects stay portable).
- No MIDI clock send/receive (own plan if ever).

### Display
- Theme picker (toolbar ☀/🌙 button moves here).
- UI scale — global zoom factor for chrome (root font-size).
- Global visualizer quality cap — machine-level fps/res ceiling clamping
  per-project `visDisplayOf` values.

### AI
- Embed `AiSettingsPanel` and **remove it from the AI dialogs**; dialogs get a
  "configure in Options" link when unconfigured.

### General
- **Autosave + recovery** — toggle + interval (default 30s, debounced on
  graphChanged idle), full `serializeWithSamples()` to **IndexedDB** single
  "last session" record (localStorage ~5MB quota too small with samples).
  Restore prompt on load.
- Project defaults: default BPM for new projects, confirm-before-leave toggle.
- Restart tutorial button (toolbar ? button moves here).

### Shortcuts
- Read-only cheat sheet of existing bindings (Cmd+G, Cmd+Z, …). No remapping.

### Debug
- Perf stats: UI fps counter, audio load (render-quantum time vs budget),
  module/wire/voice counts.
- **Underruns meter** — browsers expose no underrun event; approximate via
  render-quantum timing gaps in the worklet.
- Engine state dump + one-click "copy diagnostics" (ctx state, sample rate,
  latencies, worklet alive, sample slots).
- Console log level / event tracing toggle (needs small logging layer over the
  raw console calls).
- MIDI monitor — live incoming byte log (mirror of `sentLog` pattern for
  inputs).

### Storage/Samples
- Folder management entry point (links to existing Sample Library), clear
  cached samples, show IndexedDB/localStorage usage.

## Toolbar changes
- Add ⚙ Options. Remove ☀/🌙 theme toggle and ? tutorial button (move into
  dialog). Save/Load/AI/Samples/transport stay.

## Phasing (each shippable + e2e per repo conventions)
1. **P1** — settings store (incl. theme/aiprovider migration), dialog shell,
   Project / Display / AI / General-defaults tabs, toolbar ⚙ + removals.
2. **P2** — Audio tab (device, latency, sample rate, master gain, auto-restart)
   + MIDI tab (devices, mapping manager, per-device filter).
3. **P3** — Debug tab (perf, underruns, diagnostics, log level, MIDI monitor),
   autosave/recovery, Shortcuts + Storage tabs.
