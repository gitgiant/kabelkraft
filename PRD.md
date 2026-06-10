# KabelKraft — Product Requirements Document

**Version:** 0.1 (draft)
**Date:** 2026-06-09
**Status:** For review — open decisions flagged inline with ⚠️

---

## 1. Overview

KabelKraft is a modular audio playground: a 2D canvas where users place **modules**
(sound generators, effects, sequencers, controllers, visualizers) and wire their
inputs and outputs together to build sounds, music, and visuals. It sits between a
toy (immediate, playful, visual) and an instrument (deep enough for real sound
design and performance), in the lineage of Pure Data, VCV Rack, Max/MSP, and
Bespoke Synth — but with a friendlier learning curve, first-class visual feedback,
and AI-assisted patch building.

### Vision statement

> Anyone can drag a synth onto the canvas, wire it to a sequencer, and hear sound
> within 60 seconds — and the same canvas scales to deep, layered patches a
> professional would build.

---

## 2. Goals and Non-Goals

### Goals

- G1. Visual patching: wire modules together with audio and data connections.
- G2. Abstraction: nest module groups arbitrarily deep, zoom in/out of them.
- G3. Immediate feedback: wires pulse with signal, every object explains itself on hover.
- G4. Full creative loop: generate → sequence → process → visualize → record, all in-app.
- G5. AI-assisted patching: describe a patch in natural language, get a loadable module group.
- G6. Shareable artifacts: projects and module groups are portable files.
- G7. Eventually run as browser app, VST plugin, and standalone app from one codebase.

### Non-Goals (v1)

- Not a DAW: no multi-track timeline arrangement view (the Composer module covers
  pattern/song structure within the modular paradigm).
- No collaborative/multiplayer editing.
- No mobile-native app (touch is supported on desktop touchscreens; phone form
  factor is out of scope).
- No plugin hosting (loading third-party VSTs inside KabelKraft) in v1 — candidate for v2.
- No cloud sync / accounts in v1; files are local.

---

## 3. Core Concepts and Terminology

| Term | Definition |
|---|---|
| **Module** | A unit on the canvas with optional inputs, optional outputs, and a control surface. |
| **Port** | A typed input or output connection point on a module. |
| **Wire** | A connection from one output port to one input port. Carries exactly one signal type. |
| **Module Group** | A container of modules and wires, collapsible to a single module with its own exposed ports. Groups nest arbitrarily. |
| **Patch / Project** | The entire canvas state: all modules, groups, wires, settings. Saved as one file. |
| **Preset** | A saved configuration for a single module or module group, loadable from the Module Menu. |
| **Master Transport** | The global tempo/play/stop/pause/rewind module all modules sync to by default. |

A module is **not required** to have inputs or outputs. Examples: the Notepad has
neither; a Knob has only an output; the Recorder has only inputs.

---

## 4. Signal Type System

**Decided: all ports are typed.** Untyped ports lead to "wonky" connections
(e.g., raw audio into a BPM field). Five wire types:

| Type | Color (default) | Rate | Carries | Examples |
|---|---|---|---|---|
| **Audio** | Amber | Sample rate, block-based | PCM samples (mono or stereo per wire) | Synth out → Reverb in |
| **Note** | Cyan | Event-based | Note on/off, pitch, velocity, channel (MIDI-equivalent) | Sequencer → Synth |
| **Control** | Magenta | Control rate (~1 kHz) | Continuous normalized value 0.0–1.0 (with optional declared range/unit) | LFO → Filter cutoff, Knob → anything |
| **Trigger** | Green | Event-based | Single momentary pulse | Drum pad → Envelope retrigger |
| **Transport** | White | Event + clock | Play/stop/pause/rewind, song position, tempo | Master Transport → Composer |

### 4.1 Data type definitions (payloads)

Exact payloads carried per wire type. These definitions are normative: the engine,
the patch JSON schema (§10.1, §15), and the AI spec pack all share them.

**Audio**
- 32-bit float PCM, processed in blocks (engine block size from Audio Options).
- Channel layout per wire: **stereo by default**, `mono` available.
  Mono→stereo input auto-upmixes; stereo→mono input auto-downmixes (−3 dB sum).
  **Splitter** and **Merger** utility modules split a stereo wire into mono L/R
  and group mono wires into a stereo pair, for surgical per-channel routing.
- Nominal range −1.0…+1.0; headroom permitted between modules (no clipping
  inside the graph — clipping only at Audio Output, behind its limiter).

**Note** — polyphonic event stream. Events:

| Event | Fields |
|---|---|
| `noteOn` | `pitch` (float MIDI note number; fractional = microtonal), `velocity` (0.0–1.0), `voiceId` (int, engine-assigned), `channel` (1–16) |
| `noteOff` | `voiceId`, `releaseVelocity` (0.0–1.0) |
| `pressure` | `voiceId`, `value` (0.0–1.0) — poly aftertouch |
| `pitchBend` | `voiceId` or channel-wide, `semitones` (float) |

  `voiceId` keys the polyphonic stream: receivers track voices by id, never by
  pitch (allows same-pitch overlaps, MPE-style per-voice expression). MIDI in/out
  modules translate to/from raw MIDI 1.0 (and MIDI 2.0/MPE where available).

**Control**
- Continuous `float` 0.0–1.0, sampled at control rate (~1 kHz), linearly
  interpolated by receivers to avoid zipper noise.
- Output ports may declare semantic metadata: `unit` (Hz, dB, semitones, %, ms),
  `range` (min/max), `curve` (linear/log/exp). Receivers map normalized value
  through their own parameter range; declared units enable smarter tooltips and
  AI patch generation, not connection restrictions.
- Endless knobs emit `relative` mode: signed delta per tick instead of absolute
  value; absolute Control inputs accumulate deltas, clamped to range.

**Trigger**
- Momentary event: `time` (sample-accurate timestamp) + optional `strength`
  (0.0–1.0, default 1.0 — lets velocity-ish behavior ride a trigger).
- No duration. Gate behavior (sustain) is Note territory; converters bridge.

**Transport**
- State events: `play`, `stop`, `pause`, `rewind`, `seek(position)`.
- Continuous clock: `tempo` (BPM, float), `timeSignature` (num/denom),
  `songPosition` (beats, float, sample-accurate), `bar`/`beat` derived.
- Carried implicitly from Master Transport to every synced module; explicit
  Transport wires override the implicit feed (e.g., Composer re-driving a
  section, external MIDI clock slave).

### 4.2 Converter modules (type adapters)

Built-in tiny modules, auto-offered on incompatible drag (§4.3):

| Converter | From → To | Behavior |
|---|---|---|
| Note→Control | Note → Control | Extract pitch, velocity, or gate as continuous value; last-voice or highest/lowest-voice policy. |
| Control→Note | Control → Note | Quantize value to pitch in selected scale; threshold-crossing emits noteOn/noteOff. |
| Audio→Control | Audio → Control | Envelope follower: attack/release smoothing, gain. |
| Trigger→Note | Trigger → Note | Fixed or random pitch, strength→velocity, fixed gate length. |
| Note→Trigger | Note → Trigger | Fires on every noteOn; velocity→strength. |
| Control→Trigger | Control → Trigger | Threshold crossing with hysteresis. |

### 4.3 Connection rules

- A wire connects one **output** to one **input** of the **same type**.
- **Fan-out** is allowed: one output may feed many inputs.
- **Fan-in** is type-dependent:
  - Audio inputs: multiple wires allowed, implicitly summed (with hover diagnostic showing per-wire level).
  - Note/Trigger inputs: multiple wires allowed, events merged.
  - Control inputs: **one wire only** (last-connected wins, prior wire is detached with an animation) — summing control signals is ambiguous and confusing.
- **Converters** (§4.2) bridge types where meaningful; the UI offers them
  automatically when the user drags an incompatible wire to a port
  ("Insert Note→Control converter?").
- Incompatible ports visibly reject the wire (port flashes red, tooltip explains why).

### 4.4 Wire visualization

- Audio wires pulse with the actual signal amplitude (brightness/thickness follows level).
- Data wires (Note/Control/Trigger/Transport) pulse in their type color on each event,
  Control wires glow proportional to current value.
- Wires render **behind** modules. Modules never overlap (see §11).

---

## 5. Canvas and Wiring UX

- Infinite 2D canvas with pan (drag empty space / middle-mouse) and zoom (scroll / pinch).
- **Creating wires:** click-drag from any port, or double-click a port to start a
  wire that follows the cursor. While dragging, compatible ports highlight;
  incompatible ports dim. Releasing on a compatible port connects with a snap
  animation and a soft click sound. Releasing on empty canvas opens a quick
  "create connected module" search palette (stretch goal) or cancels.
- **Deleting wires:** click a wire to select, press Delete; or drag a port end off its port.
- **Hover tooltips** on every object (module, port, wire, control):
  - What it is and what it does (one sentence).
  - Live values: port signal levels, current control values, event rate, diagnostics
    (e.g., "Audio: −6.2 dB peak", "Note: last C#4 vel 96", "CPU: 0.8%").
  - Tooltips appear after ~400 ms, never block ports, dismiss on movement.
- **Module placement:** drag from Module Menu onto canvas. Modules auto-shove
  neighbors apart rather than overlapping (soft collision). Snap-to-grid optional.
- Inputs on the **left edge** of modules, outputs on the **right edge**, by default.
  Unlocked layout mode (§7) lets users reposition ports.

---

## 6. Module Groups (Abstraction)

- Select modules → "Group" action creates a Module Group.
- A collapsed group looks like a single module. Its external ports are the
  **exposed** ports of internal modules; the user chooses which internal ports to
  expose (default: any port that had a wire crossing the group boundary at
  creation time).
- **Zoom in** (double-click, or zoom gesture past a threshold) opens the group:
  internal modules and wiring shown, editable in place, with a breadcrumb trail
  (e.g., `Project ▸ Drum Rack ▸ Kick Chain`) and dimmed surroundings.
- Groups nest arbitrarily: a group can contain groups.
- Groups can expose selected internal controls on their collapsed face
  ("macro controls"), so a collapsed group can still be performed.
- Labeling and coloring: every module, group, and wire supports a custom label
  and color (color also tints the wire's idle state; pulse color stays type-coded).

---

## 7. Universal Module Features

Every module and module group has, via a compact header/context menu:

| Feature | Behavior |
|---|---|
| Save config | Save this module's settings as a named preset (file). |
| Load config | Load a preset (only presets of matching module type / group schema). |
| Undo / Redo | Global undo stack covering wiring, placement, grouping, AND control changes. Per-module buttons act as filtered shortcuts into the same global stack. |
| Unlock / Lock layout | Unlocked: move ports, resize module, rearrange controls. Locked (default): controls operate normally and can't be accidentally rearranged. |
| Randomize | Set all *visible* controls to random values. Excluded by design: output gain/level controls and the master tempo (randomizing volume risks hearing damage / blown speakers). Modules may mark specific controls "randomize-safe range". |
| Label / Color | Rename and tint. |
| Bypass | (Effects and processors) pass input through unprocessed. |
| Mute | (Generators) silence output. |

---

## 8. Module Catalog

### 8.1 Master Transport (always present, exactly one per project)

- Tempo (default **120 BPM**), play / stop / pause / rewind, time signature.
- Every tempo-aware module syncs to it by default via an implicit Transport
  connection (no visible wire needed; an explicit Transport output port exists
  for advanced routing).
- ⚠️ Rule addition (see §9): modules can be individually set to "free-run"
  (ignore transport) — needed for drones, ambient patches, async LFOs.

### 8.2 Sound Generators

**Sampler**
- Inputs: Note. Outputs: Audio.
- Loadable sample file (WAV, AIFF, MP3, FLAC, OGG).
- Pitch tracking (root note), polyphony, loop mode, one-shot mode.
- **Sample Editor** (opens as expanded panel/window): waveform view with zoom,
  save/load, copy/paste/cut, trim, normalize, reverse, fade in/out, loop point
  editing with crossfade, pitch shift, time stretch. Non-destructive until "save".
- ADSR amplitude envelope.

**Drum Machine**
- Inputs: Note (pads mapped to notes), Trigger per pad. Outputs: Audio (master)
  plus optional per-pad Audio outs.
- 16 pads (expandable), per-pad: sample slot, level, pan, pitch, choke group,
  ADSR; integrated Sample Editor per pad.
- Built-in step sequencer page (per-pad steps, velocity, swing) synced to transport —
  usable standalone or driven externally by Note input.

**Sample Library**
- No audio ports. Sample explorer over the user's **own local sample folders**:
  user adds folders to the library, browses with audition (click to preview),
  tagging/favorites, search. Drag a sample directly onto a Sampler or Drum
  Machine pad to load it. No bundled sample pack required.
- *(Browser build: local folder access via the File System Access API —
  Chromium-based browsers. User grants access via a browser-native folder-picker
  permission popup, scoped to the chosen directory; the handle is persisted so
  re-grant is at most a one-click re-prompt per session. Fallback for
  Firefox/Safari and denied permission: drag-and-drop of files/folders.)*

**Synth**
- Inputs: Note; Control inputs for every major parameter. Outputs: Audio.
- Oscillator waveforms: sine, triangle, square (with PWM), sawtooth, noise.
- Modes: **classic** (2 osc + detune), **wavetable** (loadable wavetables,
  position control), **FM** (4-operator with algorithm selection).
- Controls: waveform select, coarse pitch, fine tune, octave, glide.
- Filter: multimode (LP/HP/BP) with cutoff, resonance, filter ADSR + amount.
- Amplitude ADSR. Polyphony setting (1–16 voices) with voice-steal policy.

### 8.3 Data Modules

All output data types, no audio.

| Module | Outputs | Description |
|---|---|---|
| **LFO** | Control | Shapes: sine, tri, square, saw, S&H; rate in Hz or tempo-synced divisions; phase, depth, offset; retrigger input (Trigger). |
| **ADSR** | Control | Gate input (Trigger or Note), outputs envelope as control signal — for modulating anything, not just amplitude. |
| **Formula** | Control | User-typed expression `f(t, beat, inputs…)` with up to 4 Control inputs as variables. Sandboxed math expression language (no general code execution). |
| **Random** | Control / Note / Trigger | Modes: random walk, S&H noise, random note in scale, probability trigger. Seedable. |
| **Sequencer** | Note, Trigger | Fully featured step/piano-roll sequencer: variable length, per-step pitch/velocity/gate/probability/ratchet, scale lock, **MIDI file import**, multiple patterns, pattern chaining. Syncs to transport. |
| **Arpeggiator** | Note | Input: Note (held chord). Modes up/down/up-down/random/as-played, octave range, rate (synced divisions), gate length, swing, latch. |
| **Composer** | Note (multi-out), Transport | Pattern bank + song arrangement: orders patterns into a song with position state. Follows Master Transport play/stop/pause/rewind; outputs per-track Note streams. |
| **Performance** | Note + Audio (per track) | Session-view clip grid — full spec below. |

**Performance module (defined):** non-linear counterpart to the Composer.
Where the Composer reads music left-to-right like a timeline, the Performance
module organizes audio and MIDI loops into a **grid of clips**: tracks as
columns, **scenes** as rows.

- **Grid:** each cell is a clip slot holding either a **Note clip** (MIDI
  pattern) or an **Audio clip** (sample/loop). Tracks are typed accordingly.
- **Ports:** per track — Note out (MIDI tracks) or Audio out (audio tracks);
  Note in / Audio in per track for clip recording; Trigger ins for clip/scene
  launch (wire pads, buttons, or any Trigger source to perform launches).
  Syncs to Master Transport (implicit, §4.1).
- **Clip launch:** click/tap or Trigger to launch. Per-clip modes: **loop**
  (repeats until stopped/replaced) or **one-shot** (plays once). One playing
  clip per track; launching another clip in the same track takes over at the
  quantization boundary.
- **Quantization:** global launch quantization (off, 1 bar, 1/2, 1/4, 1/8…);
  per-clip override. Launches snap to the next boundary, with the
  Ableton-style "armed and waiting" pulse on the clip until it fires.
- **Clip recording:** per-slot record button — captures incoming Note or Audio
  on that track into the slot, quantized start/stop, loop length auto-set to
  recorded bars. Overdub toggle for Note clips.
- **Scene controls:** scene-row launch button fires every clip in the row
  (quantized together); scene stop, scene rename/color; per-track stop buttons
  and a stop-all.
- **Clip editing:** Note clips open the Sequencer-style piano-roll editor;
  Audio clips open the Sample Editor (loop points, warp/stretch to tempo).

### 8.4 Effect Modules

All: Audio in → Audio out, fully fleshed controls, bypass, dry/wet where applicable.

| Effect | Controls |
|---|---|
| Reverb | Algorithm (room/hall/plate), size, decay, pre-delay, damping, diffusion, low/high cut, dry/wet. |
| Delay | Time (ms or tempo-synced), feedback, ping-pong toggle, filter in feedback path, dry/wet. |
| Chorus | Rate, depth, voices, stereo width, mix. |
| Flanger | Rate, depth, feedback, manual offset, mix. |
| Modulator | Ring mod / amplitude mod, carrier frequency or Audio sidechain input, mix. |
| Compressor | Threshold, ratio, attack, release, knee, makeup gain, sidechain Audio input, gain-reduction meter. |
| Multiband Compressor | 3–4 bands with adjustable crossovers; per-band threshold/ratio/attack/release/gain; per-band solo; spectrum + GR display. |
| Limiter | Ceiling, release, lookahead, true-peak toggle, GR meter. |
| Distortion | Algorithms (soft clip, hard clip, tube, foldback), drive, tone, output trim, mix. |
| Bitcrusher | Bit depth, sample-rate reduction, mix. |
| Simple EQ | 3-band (low shelf, mid peak, high shelf), gain + frequency each. |
| Parametric EQ | 5–8 bands, each: type (peak/shelf/cut), freq, gain, Q; **live input spectrum rendered behind the EQ curve**; drag points on the curve directly. |

### 8.5 Visual Modules

**Visualizer**
- Inputs: Audio (1–2), Note.
- Output: a resizable, full-screenable graphics window; option to render to the
  **canvas background** instead of a window.
- Scenes: oscilloscope, spectrum, particles reacting to audio + note events,
  user-selectable; scene parameters modulatable via Control inputs.

**Levels**
- Input: Audio (multi). Per-input peak/RMS meters, clip indicators with hold +
  click-to-reset, headroom readout.

### 8.6 Controller Modules

Controllers are real modules with ports — wire them anywhere a Control input exists.

| Module | Ports | Notes |
|---|---|---|
| Knob (ranged) | Control out | Min/max/curve/default configurable; double-click to type a value. |
| Knob (endless) | Control out (relative) | Emits increments; for scrubbing/offsets. |
| Slider | Control out | Horizontal or vertical, same config as Knob. |
| X-Y Controller | 2× Control out | Pad with draggable puck; optional spring-to-center; X and Y independently configurable. |
| Button / Toggle | Trigger out / Control out (0|1) | Momentary or latching. |
| Keyboard | Note out | On-screen piano keys; also echoes computer-keyboard input (QWERTY-as-piano). |

**Direct control vs. wired control:** module-embedded controls (e.g., a Synth's
cutoff knob) are also addressable: drag a wire from any Controller module onto an
embedded control to modulate it (a small modulation ring appears around the
control). This keeps "controls are modules" composable without forcing every knob
to live as a separate canvas object.

### 8.7 I/O and Utility Modules

| Module | Description |
|---|---|
| **Audio Output** | Routes to a device output channel pair (created from Audio Options config). Master level + limiter-on-by-default safety toggle. |
| **Audio Input** | Device input as Audio source (created from Audio Options config). |
| **MIDI In** | Hardware/virtual MIDI port + channel filter → Note/Control (CC) outputs. |
| **MIDI Out** | Note/Control inputs → hardware/virtual MIDI port. |
| **Recorder** | Audio inputs (multi, summed or multi-file) → record to WAV/FLAC; arm, record, stop; filename pattern; punch-in synced to transport optional. |
| **Mixer** | N Audio ins with level/pan/mute/solo per channel → stereo Audio out. |
| **Notepad** | No ports. Rich-text-lite notes, resizable. |

---

## 9. Engine Rules

1. **Tempo sync:** all tempo-aware modules lock to Master Transport by default
   (tempo, play/stop/pause/rewind, song position).
2. **Free-run override (decided):** transport sync is the default for every
   module. A Debug menu option (§14) enables the override: when on, each module
   gains a per-module free-run toggle to opt out of transport sync (e.g., drones
   and async LFOs that keep running while the transport is stopped).
3. **Feedback loops (decided): audio feedback is allowed.** The engine
   automatically inserts one block (~3 ms) of latency at the loop point, marks
   the wire with a loop badge, and applies a hard safety limiter at the loop.
   Data (Note/Control) feedback loops are evaluated with one-event delay to
   prevent infinite cascades.
   **TODO (post-v1):** refine the implementation — latency compensation
   options, per-loop gain policy, configurable loop limiter.
4. **Master safety (decided):** a brickwall limiter on the Audio Output module,
   defaulted ON, protects ears/speakers — especially given the Randomize feature.
5. **Unconnected ports (decided):** unconnected inputs use the control's
   manual value; unconnected outputs cost nothing (lazy evaluation — module
   graphs not reaching an Audio Output or Recorder are processed at control rate
   only or suspended, keeping CPU down).
6. **Polyphony semantics (decided): instrument style by default** — Note wires
   carry polyphonic streams (voices tagged by `voiceId`, §4.1); the receiving
   instrument owns voice allocation. A Debug menu option (§14) enables **voice
   breakout**: per-voice ports on Note outputs so individual voices can be wired
   separately (VCV-style) for advanced/diagnostic patching.
7. **Sample rate / block size (decided):** global project settings, set in
   Audio Options (§14); modules never see differing rates. Changing them
   rebuilds the DSP graph (brief dropout acceptable).
8. **Determinism for saving (decided):** module state (including Random module
   seeds and sequencer positions at save time) serializes fully, so a loaded
   project sounds the same as when saved.
9. **MIDI clock slave (decided):** Master Transport can slave to external MIDI
   clock (enabled per device in MIDI Options, §14).

---

## 10. AI-Generated Module Groups

**Decided: AI-generated module groups use a JSON patch format** (markdown only
for the human/AI instructions, not the data — markdown is great for
*instructions*, bad for machine-validated structure):

### 10.1 Patch format

- A module group (and a whole project) serializes to a **JSON document** with a
  published JSON Schema: modules (type + parameter values), wires
  (from/to port references), groups (recursive), layout positions, labels, colors.
- JSON because: strict validation before load, every AI is heavily trained on it,
  trivially diffable and versionable, same format used for save files — one
  serializer, no second path to maintain.

### 10.2 External AI workflow (v1 — works with any chatbot, zero API cost)

1. App ships a **spec pack**: a single markdown file (`kabelkraft-ai-spec.md`)
   containing: the JSON Schema, the full module catalog with every parameter,
   port types and connection rules, and 3–4 annotated example patches.
   One click: "Copy AI Spec to clipboard".
2. User pastes spec + their description ("make a moody techno bass with sidechain
   pumping") into Claude / ChatGPT.
3. AI replies with a JSON patch block. User pastes it into KabelKraft's
   **Import AI Patch** dialog (or drops a `.kkgroup` file).
4. KabelKraft validates against schema, reports errors readably ("module
   'superSaw' unknown — closest match 'synth'"), auto-layouts the group
   (AI-provided positions are hints only; the auto-layouter guarantees
   no overlap), and inserts it as a Module Group for review before wiring
   into the live patch.

### 10.3 Integrated AI (v2)

Same format, but in-app: prompt box → API call (user-supplied API key) →
validate → insert. Add a repair loop: validation errors are sent back to the
model automatically up to N times. The v1 spec-pack work is 100% reusable here.

---

## 11. UI Design Principles

Design intent: **clear and informative, clutter to a minimum.** Proposed
mechanisms (you asked for proposals):

1. **Progressive disclosure.** Modules have a compact face (the 3–5 controls you
   touch most) and an expanded face (everything). Toggle per module. Deep panels
   (Sample Editor, EQ curve, Sequencer grid) open as overlays, not permanent canvas residents.
2. **Zoom-dependent detail (semantic zoom).** Far out: modules render as labeled
   colored tiles with port dots, controls hidden. Mid: compact faces. Close:
   full controls. Keeps big patches legible.
3. **Visual hierarchy by motion budget.** Only signal-carrying wires animate;
   idle wires are static and slightly desaturated. Animation is information,
   never decoration — this single rule prevents the "casino" look.
4. **Foreground/background discipline.** Modules always above wires; wires route
   under modules (design doc requirement). Wire paths use smooth curves with
   automatic spacing so parallel wires don't merge visually.
5. **Color = identity, shape = function.** User colors tint module bodies and
   wire idle color; port shapes/type colors never change, so signal types stay
   instantly readable regardless of theme.
6. **One inspector, not N panels.** Selecting any object shows its full details
   in a single collapsible side inspector — tooltips for glance, inspector for depth.
7. **Search-first module menu.** Module Menu = dockable palette with search,
   categories, favorites, recents, and user-saved groups; drag-drop to canvas.

### Menus

- **Module Menu:** browse/search built-in modules and module groups; save current
  selection/group as a reusable preset; manage (rename, delete, organize into folders) saved groups.
- **Project Menu:** new, open, save, save-as, recent projects, autosave with
  crash recovery, project import/export as a single file (samples optionally
  embedded or referenced — embedded by default for portability).

---

## 12. Tutorial

Interactive, in-canvas, skippable, ~3 minutes:

1. Drag a Synth from the Module Menu (menu pulses to guide).
2. Drag a Keyboard controller; wire Note → Synth (teaches wiring + snap).
3. Play notes — hear sound, see the audio wire pulse amber.
4. Add an LFO, wire Control → Synth cutoff (teaches **data vs. audio**: different
   color, different meaning — narrated explicitly).
5. Add a Reverb between Synth and Audio Out (teaches inserting into an existing wire).
6. Group the Synth+LFO+Reverb (teaches groups + zoom).
7. Pointer to tutorial #2 (sequencer + drum machine) and #3 (AI patch import).

Tutorials implemented as scripted overlays on a real patch — the end state is a
working patch the user keeps.

---

## 13. Input Methods

- **Mouse + keyboard** (primary): full keyboard shortcut map (delete, duplicate,
  group, undo/redo, zoom, search palette).
- **Touch (decided: integrated, v1):** touch does not force the design; it is
  built in from the start:
  - Minimum hit targets ~40 px at default zoom for ports and primary controls
    (also improves mouse usability).
  - No hover-only critical information — everything in tooltips is also in the
    inspector, since touch has no hover.
  - Core gestures in v1: tap = click, drag = move/wire, pinch = zoom,
    two-finger drag = pan, long-press = right-click/context menu,
    double-tap = open group / start wire.
  - Multi-touch performance gestures (two controls at once) are v2.

---

## 14. Options Menu

### Audio
- Driver selection: **ASIO** (Windows), WASAPI, CoreAudio (macOS); device,
  sample rate, buffer size with measured round-trip latency readout.
- Enable/name available input and output channels; enabled channels appear as
  Audio Input / Audio Output modules in the Module Menu.
- Input/output level meters and master trim in the options panel.
- *(Browser build: this panel shows Web Audio output device selection and
  explains that ASIO requires the standalone app — see §16.)*

### MIDI
- List of detected MIDI devices (hot-plug aware); enable per device.
- Per-device port and channel filters for in and out; MIDI clock send/receive
  toggle (receive = Master Transport slaves to external clock, rule §9.9).
- MIDI learn: right-click any control → "MIDI Learn" → move a hardware knob.

### Display
- Custom background image: center, stretch, tile, fill; opacity/dim slider so the
  background never fights the patch. Visualizer-to-background option hooks in here.
- Visual effects toggles: wire glow, wire pulse animation, snap animations
  (one master "reduce motion" switch as well — accessibility).
- **Color templates:** named themes coloring modules, wires, UI chrome, canvas.
  Ships with **Dark (default)** and **Light**; user themes via a simple editor
  (pick ~10 base colors, everything derives); import/export theme files.

### Debug
- Toggle debug log panel, FPS counter, performance diagnostics (per-module CPU %,
  total DSP load, memory), audio underrun counter with last-underrun timestamp.
- **Voice breakout** toggle (rule §9.6): exposes per-voice ports on Note outputs
  so individual voices can be wired separately.
- **Free-run override** toggle (rule §9.2): exposes a per-module free-run
  setting to opt modules out of transport sync.

---

## 15. Persistence

| Artifact | Extension | Contents |
|---|---|---|
| Project | `.kkproj` | Full canvas: modules, params, wires, groups, layout, theme override, embedded or referenced samples. (Zip container: `project.json` + `samples/`.) |
| Module group preset | `.kkgroup` | One group, same JSON schema subset; what the AI workflow emits. |
| Module preset | `.kkmod` | Single module's parameter state. |
| Theme | `.kktheme` | Color template. |

All JSON-based, versioned with a `formatVersion` field and forward-migration on load.

---

## 16. Software Stack — Cost/Benefit Analysis

### The four options

| | A. Browser | B. VST plugin | C. Standalone | D. All three |
|---|---|---|---|---|
| **Latency** | Good, not pro-grade: ~10–30 ms output via AudioWorklet; no ASIO, ever (browser security model). Fine for playground use; tight live drumming will feel it. | Host-grade: DAW owns the driver (ASIO etc.); plugin inherits ~3–10 ms. | Best available: direct ASIO/CoreAudio, down to ~3–6 ms. | Each target gets its native ceiling. |
| **Audio interface support** | Output device selection yes; multi-channel and input routing limited and browser-dependent. No ASIO. | Inherits everything from DAW. | Full control. | Full where it matters. |
| **MIDI** | Web MIDI works in Chrome/Edge/Firefox; **no Safari**. Sysex needs permission prompt. Good enough. | Host-routed MIDI, excellent. | Full (RtMidi etc.), excellent. | Full. |
| **Distribution/iteration** | Unbeatable: send a URL, zero install, instant updates. Best prototyping loop by far. | Hardest: per-host quirks, per-OS installers, code signing, plugin validation. | Installer + signing, but self-contained. | All of the above costs. |
| **Dev effort (relative)** | 1.0× | 1.6× (DSP shared, but plugin shell + host debugging is real pain) | 1.3× | ~2.2× if architected for it from day one; ~4× if retrofitted. |
| **Your language fit** | TypeScript (new but high-level) + C/C++ via WASM for DSP. | C++ (you: "somewhat familiar") — effectively mandatory (JUCE). | C++ best fit given C background; Rust steeper. | C++ core + TS UI. |
| **Risks** | Latency ceiling; Safari MIDI gap; GC pauses must be kept out of audio path (doable: WASM + AudioWorklet, no JS allocation in callback). | Slow iteration speed will hurt an experimental product early. | Have to build all the "host" plumbing yourself (device mgmt, etc.). | Architecture discipline required from commit #1. |

### Key technical fact that decides this

One architecture serves all four targets **if and only if** two rules hold from
day one:

1. **DSP core in portable C++** with zero UI/OS dependencies — compiles natively
   (standalone, VST) *and* to WASM (browser, inside an AudioWorklet).
2. **UI in web tech (TypeScript + Canvas/WebGL)** — runs in the browser as-is,
   and in standalone/VST via a webview. JUCE 8 ships first-class WebView UI
   support precisely for this pattern; the standalone app can be the JUCE
   standalone target or Tauri.
3. Between them, a thin **message protocol** (param changes, port wiring ops,
   meter/analysis data out). This protocol is the same thing the patch JSON and
   the AI format build on — the work compounds.

This is the architecture used by several modern hybrid audio products; it is
proven, not speculative.

### Decision

**Decided: option D, via a portable C++ DSP core (compiles native AND to WASM)
plus a TypeScript/Canvas UI (runs in the browser as-is, and in VST/standalone
via JUCE 8 WebView).** Build order:

**Phase 1 (prototype, ~weeks → first sound):** pure browser. TypeScript +
Web Audio AudioWorklet; write the first DSP in TS or AssemblyScript to move fast.
Validates the entire UX (canvas, wiring, groups, tooltips, AI import) where
iteration is cheapest. Almost all of this code is keeper code: the UI **is** the
final UI.

**Phase 2 (engine hardening):** port/rewrite DSP into a C++ core compiled to
WASM. Browser app now has the production engine. C++ chosen over Rust because:
your C background transfers directly, JUCE (the de-facto VST framework) is C++,
and the WASM toolchain (Emscripten) is mature. Rust is viable (`nih-plug`,
`wasm-bindgen`) but adds a learning curve on the critical path for no decisive
gain here.

**Phase 3 (native targets):** wrap the same C++ core + web UI in JUCE 8 →
**VST3 plugin** (FL Studio, Ableton) and **standalone app** with ASIO/CoreAudio.
Standalone is where the §14 ASIO requirements are fully satisfied; the options
UI feature-detects per platform.

Cost of this path vs. browser-only: roughly +60–80% total effort, paid mostly in
Phases 2–3, none of it blocking early product learning. Cost of retrofitting
instead: rewriting the DSP and the UI/engine boundary — the expensive ~4× path.
**Build order: A (browser) → engine (C++/WASM) → B+C (VST + standalone).**

---

## 17. Phased Roadmap

| Phase | Scope | Exit criterion |
|---|---|---|
| **0. Skeleton** | Canvas, module framework, typed ports, wiring UX, Master Transport, Synth (classic), Keyboard, Audio Out, Levels, save/load project. | "60 seconds to sound" demo works in browser. |
| **1. Playground** | Module groups + zoom, undo/redo, tooltips, touch input (tap/drag/pinch/pan/long-press), Sampler (basic), Sequencer, LFO/ADSR/Random, 4 core effects (delay, reverb, distortion, simple EQ), Mixer, Recorder, tutorial #1, themes (dark/light). | A friend can build a beat unassisted. |
| **2. Depth** | Drum Machine, Sample Editor, Sample Library, wavetable+FM synth modes, remaining effects incl. parametric EQ, Arpeggiator, Composer, Visualizer, MIDI in/out + MIDI learn, AI spec pack + import dialog. | Feature-complete vs. this PRD (browser). |
| **3. Native** | C++ DSP core to WASM + native; JUCE VST3; standalone with ASIO. | Plugin runs in FL Studio & Ableton; standalone <10 ms RTT. |
| **4. v2 themes** | Performance module, integrated AI with repair loop, plugin hosting?, multi-touch performance. | — |

---

## 18. Testing and Quality

**Requirement: fully automated test framework, running in CI on every commit.**
The browser-first architecture (§16) is deliberately leveraged for this — the
entire app is browser-testable end to end. Three layers:

1. **DSP core unit tests** — C++ core tested natively (GoogleTest or Catch2);
   the *same* test suite runs against the WASM build to catch
   compilation-target divergence. Deterministic: fixed seeds (§9.8), fixed
   sample rate/block size.
2. **Engine integration tests** — render whole patches offline
   (`OfflineAudioContext` in browser; direct block rendering natively) and
   assert on output: golden-file comparison with tolerance, plus analysis
   assertions (RMS level, spectral peaks, note timing). Patch JSON (§10.1) is
   the test fixture format — tests are loadable patches.
3. **UI end-to-end tests** — Playwright (headless Chromium primary; Firefox/
   WebKit for fallback paths): canvas interactions (place module, drag wire,
   snap, reject incompatible), grouping/zoom, undo/redo, save/load round-trip,
   AI patch import validation, touch gesture emulation. Fake audio/MIDI devices
   via browser launch flags; File System Access flows covered by Playwright
   permission grants, drag-drop fallback covered cross-browser.

**TODO: write test cases** — derive an initial test plan from this PRD
(one case per decided rule in §9, per connection rule in §4.3, per module's
core behavior) before Phase 0 ends; grow alongside each phase.

---

## 19. Open Questions

1. Name/branding check for "KabelKraft" (existing trademarks in audio software space) before public release.
2. Feedback loop refinements (§9.3 TODO, post-v1): latency compensation options, per-loop gain policy, configurable loop limiter.
