/**
 * Central app state: the patch graph, the audio engine, transport, selection,
 * and live meter/note-activity data the canvas reads each frame.
 * Plain event-emitter pattern so both Pixi code and Svelte chrome can listen.
 */

import { Graph, type PortRef, type Wire } from './core/graph';
import { createInstance, type ModuleInstance } from './core/module';
import { MODULE_DEFS } from './core/registry';
import { decodeSample, encodeSample, parseSampleKey, sampleKey, type SampleData } from './core/samples';
import { deserializeProject, serializeProject } from './core/serialize';
import { parseKkGroup } from './core/aiimport';
import { planAutoWire } from './core/autowire';
import { parseKkProject, type KkProjectGroup } from './core/aiproject';
import {
  defaultFace,
  exportKkmod,
  importKkmod,
  pruneFaceBindings,
  type FaceSpec,
} from './core/face';
import { MidiManager } from './core/midi';
import { SttManager } from './core/stt';
import { formatTransportText, noteName } from './core/texttools';
import { DEFAULT_TRANSPORT, type TextEvent, type TransportState } from './core/types';
import { Engine } from './engine/engine';
import type { MeterReading, StatusMessage } from './engine/messages';
import { encodeWav } from './engine/wav';
import type { VisDisplay } from './visual/display';
import { VisFeatureHub } from './visual/features';
import { visGraphOf } from './visual/migrate';
import { createVisRingBuffer } from './visual/ring';
import { ContainerRenderer, visFramesRendered, visGpuErrors, type ContainerFrame } from './visual/runtime';
import { hslToRgbInt, rgbIntToHsl } from './core/color';
import type { VisFeatures, VisGraphData } from './visual/types';

export type StateEvent =
  | 'graphChanged' // modules/wires added or removed — structural
  | 'paramChanged'
  | 'transportChanged'
  | 'selectionChanged'
  | 'projectLoaded'
  | 'sampleLoaded'
  | 'editorChanged' // sample editor opened/closed
  | 'midiChanged' // MIDI-learn armed/disarmed or mapping changed
  | 'visualizerChanged' // big visualizer overlay opened/closed
  | 'visEditorChanged' // visual graph editor opened/closed
  | 'visGraphChanged' // a container's nested visual graph was edited
  | 'faceEditorChanged' // face editor opened/closed
  | 'faceLearnChanged' // face learn armed/canceled/completed
  | 'composerChanged' // piano-roll editor opened/closed
  | 'composerAiRequest' // container 🤖 button: open a composer's AI popup
  | 'rangeConfigChanged'; // knob/slider range popup opened/closed

type Listener = () => void;

export class AppState {
  graph = new Graph(MODULE_DEFS);
  readonly engine = new Engine();
  transport: TransportState = { ...DEFAULT_TRANSPORT };
  projectName = 'Untitled';

  /** Live per-module meters from the engine, refreshed ~30 Hz. */
  meters: Record<string, MeterReading> = {};
  /** Current step per sequencer module (playhead UI), from the engine. */
  seqSteps: Record<string, number> = {};
  /** Live control output values per source module (wire glow). */
  controlValues: Record<string, number> = {};
  /** Live gain reduction (dB) per compressor/limiter, for GR meters. */
  gainReduction: Record<string, number> = {};
  /** Live input spectra (64 log bins, dB) per parametric EQ. */
  spectra: Record<string, number[]> = {};
  /** Live visualizer feeds (notes/ctrl/onset; raw windows only without SAB). */
  visData: StatusMessage['visData'] = {};
  /** Per-frame audio analysis for visual containers (FFT etc. run UI-side). */
  private readonly visHub = new VisFeatureHub();

  /** Current audio features for one visualizer container; null until audio arrives. */
  visFeatures(moduleId: string): VisFeatures | null {
    return this.visHub.features(moduleId, performance.now());
  }

  /** Total frames the WebGPU visual runtime rendered (e2e progress probe). */
  visFramesRendered(): number {
    return visFramesRendered();
  }

  /** WebGPU validation errors this session (0 = shaders healthy) — e2e probe. */
  visGpuErrors(): number {
    return visGpuErrors();
  }

  /**
   * Build the render chain for one visualizer: its graph + features plus the
   * upstream containers wired into its Vis In pole (cycles broken — an
   * already-visited container upstream is skipped).
   */
  visFrame(moduleId: string, visited: Set<string> = new Set()): ContainerFrame | null {
    const mod = this.graph.modules.get(moduleId);
    if (mod?.type !== 'visualizer' || visited.has(moduleId)) return null;
    const graph = visGraphOf(mod.data);
    if (!graph) return null;
    visited.add(moduleId);
    const upstream: ContainerFrame[] = [];
    for (const w of this.graph.wires.values()) {
      if (w.type !== 'visual' || w.to.moduleId !== moduleId || w.to.portId !== 'vin') continue;
      const up = this.visFrame(w.from.moduleId, visited);
      if (up) upstream.push(up);
    }
    return { id: moduleId, graph, features: this.visFeatures(moduleId), upstream };
  }

  // -- text streams (VISUALIZER_ENGINE_PLAN.md Phase 3) -----------------------

  /** Speech-to-text sessions, one per stt module. */
  readonly stt = new SttManager();
  /** Latest text event per producer module (faces read this each frame). */
  textValues: Record<string, TextEvent> = {};
  /** Last emitted transport readout per transporttext module (change detection). */
  private transportTextLast = new Map<string, string>();

  /**
   * Emit a text event from a producer module and route it along text wires
   * into visualizer containers (text wires live UI-side, like color wires).
   */
  emitText(producerId: string, text: string, final = true): void {
    this.textValues[producerId] = { text, final };
    for (const w of this.graph.wires.values()) {
      if (w.type !== 'text' || w.from.moduleId !== producerId) continue;
      const target = this.graph.modules.get(w.to.moduleId);
      if (target?.type === 'visualizer') this.visHub.pushText(target.id, text, final);
    }
  }

  /** Toggle a Speech-to-Text module's mic session; returns the new state. */
  toggleStt(moduleId: string): boolean {
    if (this.stt.active(moduleId)) {
      this.stt.stop(moduleId);
      return false;
    }
    return this.stt.start(moduleId, (text, final) => this.emitText(moduleId, text, final));
  }

  /** Text Input module: send one typed line. */
  sendTextInput(moduleId: string, text: string): void {
    const mod = this.graph.modules.get(moduleId);
    if (!mod) return;
    mod.data = { ...mod.data, lastText: text };
    this.emitText(moduleId, text, true);
  }

  /** Per-status text producers driven by engine state (~30 Hz). */
  private tickTextProducers(textNotes: Record<string, number[]>): void {
    for (const mod of this.graph.modules.values()) {
      if (mod.type === 'transporttext') {
        const line = formatTransportText(mod.params.format ?? 0, this.transport);
        if (this.transportTextLast.get(mod.id) !== line) {
          this.transportTextLast.set(mod.id, line);
          this.emitText(mod.id, line, true);
        }
      }
    }
    for (const [id, pitches] of Object.entries(textNotes)) {
      if (pitches.length > 0) this.emitText(id, pitches.map(noteName).join(' '), true);
    }
  }
  // -- derived tints (frame color → UI accents) -----------------------------

  /** Smoothed derived frame colors (packed 24-bit RGB) per visual-source module. */
  tintValues: Record<string, number> = {};
  /** Raw sampled targets (luminance-clamped); tintValues eases toward these. */
  private tintTargets: Record<string, number> = {};
  /** Cached "who needs a tint" set; invalidated on structural changes. */
  private tintSourcesCache: Set<string> | null = null;

  /** Visual sources consumed as a tint: wires into `tint` endpoints (module
   * ports and group intrinsic poles) plus face-element bindings. */
  tintSourceIds(): Set<string> {
    if (!this.tintSourcesCache) {
      const s = new Set<string>();
      for (const w of this.graph.wires.values()) {
        if (w.type === 'visual' && w.to.portId === 'tint') s.add(w.from.moduleId);
      }
      for (const g of this.graph.groups.values()) {
        for (const el of g.face?.elements ?? []) {
          if (el.tintSourceId) s.add(el.tintSourceId);
        }
      }
      this.tintSourcesCache = s;
    }
    return this.tintSourcesCache;
  }

  /** Sampler callback: clamp to a readable luminance and set the ease target. */
  private pushTintSample(id: string, rgb: number): void {
    if (!this.tintSourceIds().has(id)) return;
    const { h, s, l } = rgbIntToHsl(rgb);
    this.tintTargets[id] = l < 0.22 ? hslToRgbInt(h, s, 0.22) : rgb;
  }

  /** Source module feeding a tint endpoint (module tint port or group pole). */
  private tintWireInto(id: string): string | null {
    for (const w of this.graph.wires.values()) {
      if (w.type === 'visual' && w.to.moduleId === id && w.to.portId === 'tint') {
        return w.from.moduleId;
      }
    }
    return null;
  }

  /** Nearest tint source for a module: own tint port, then enclosing groups
   * inside-out (nearest wired ancestor wins). Null = default accent. */
  tintSourceFor(moduleId: string): string | null {
    const own = this.tintWireInto(moduleId);
    if (own) return own;
    let group = this.graph.groupOfModule(moduleId);
    while (group) {
      const src = this.tintWireInto(group.id);
      if (src) return src;
      group = this.graph.parentGroup(group.id);
    }
    return null;
  }

  /** Nearest tint source for a group: its own pole, then ancestors. */
  tintSourceForGroup(groupId: string): string | null {
    let group = this.graph.groups.get(groupId);
    while (group) {
      const src = this.tintWireInto(group.id);
      if (src) return src;
      group = this.graph.parentGroup(group.id);
    }
    return null;
  }

  /** Resolved tint color for a module, if any source is wired and sampled. */
  tintFor(moduleId: string): number | null {
    const src = this.tintSourceFor(moduleId);
    return src ? (this.tintValues[src] ?? null) : null;
  }

  /** Resolved tint color for a group tile/face, if any. */
  tintForGroup(groupId: string): number | null {
    const src = this.tintSourceForGroup(groupId);
    return src ? (this.tintValues[src] ?? null) : null;
  }

  /** Ease displayed tints toward their targets (~150 ms); canvas calls per frame. */
  tickTints(dtMs: number): void {
    const wanted = this.tintSourceIds();
    const k = 1 - Math.exp(-dtMs / 150);
    for (const id of Object.keys(this.tintTargets)) {
      if (!wanted.has(id) || !this.graph.modules.has(id)) {
        delete this.tintTargets[id];
        delete this.tintValues[id];
        continue;
      }
      const target = this.tintTargets[id];
      const cur = this.tintValues[id];
      if (cur === undefined) {
        this.tintValues[id] = target;
        continue;
      }
      const lerp = (a: number, b: number) => Math.round(a + (b - a) * k);
      this.tintValues[id] =
        (lerp((cur >> 16) & 0xff, (target >> 16) & 0xff) << 16) |
        (lerp((cur >> 8) & 0xff, (target >> 8) & 0xff) << 8) |
        lerp(cur & 0xff, target & 0xff);
    }
  }
  /** Module id showing the big in-tile visualizer view; null = closed. */
  visualizerOpen: string | null = null;
  /** Compact tile size remembered across big-view open ↔ close. */
  private visualizerShrunkSize: { w?: number; h?: number } | null = null;

  /** Tile size while the big view is open (world px). */
  static readonly VIS_OPEN_W = 960;
  static readonly VIS_OPEN_H = 640;

  /** Opens the big view in place — the tile grows (no full-screen takeover). */
  openVisualizer(moduleId: string): void {
    const mod = this.graph.modules.get(moduleId);
    if (mod?.type !== 'visualizer') return;
    this.closeVisEditor(); // one in-tile panel at a time
    if (this.visualizerOpen !== moduleId) {
      this.closeVisualizer();
      this.visualizerShrunkSize = { w: mod.w, h: mod.h };
      mod.w = Math.max(mod.w ?? 0, AppState.VIS_OPEN_W);
      mod.h = Math.max(mod.h ?? 0, AppState.VIS_OPEN_H);
      this.emit('graphChanged');
    }
    this.visualizerOpen = moduleId;
    this.emit('visualizerChanged');
  }

  closeVisualizer(): void {
    const mod = this.visualizerOpen ? this.graph.modules.get(this.visualizerOpen) : null;
    if (mod && this.visualizerShrunkSize) {
      const prev = this.visualizerShrunkSize;
      if (prev.w === undefined) delete mod.w;
      else mod.w = prev.w;
      if (prev.h === undefined) delete mod.h;
      else mod.h = prev.h;
      this.emit('graphChanged');
    }
    this.visualizerShrunkSize = null;
    this.visualizerOpen = null;
    this.emit('visualizerChanged');
  }

  /** Module id whose visual graph editor is open; null = closed. */
  visEditorOpen: string | null = null;
  /** Compact tile size remembered across editor open ↔ close. */
  private visEditorShrunkSize: { w?: number; h?: number } | null = null;

  /** Tile size while the visual graph editor is open (world px). */
  static readonly VISED_OPEN_W = 900;
  static readonly VISED_OPEN_H = 600;

  /** Opens the graph editor in place — the tile grows like the composer's. */
  openVisEditor(moduleId: string): void {
    const mod = this.graph.modules.get(moduleId);
    if (mod?.type !== 'visualizer') return;
    this.closeVisualizer(); // one in-tile panel at a time
    if (this.visEditorOpen !== moduleId) {
      this.closeVisEditor();
      this.visEditorShrunkSize = { w: mod.w, h: mod.h };
      mod.w = Math.max(mod.w ?? 0, AppState.VISED_OPEN_W);
      mod.h = Math.max(mod.h ?? 0, AppState.VISED_OPEN_H);
      this.emit('graphChanged'); // tile resize is canvas-structural
    }
    this.visEditorOpen = moduleId;
    this.emit('visEditorChanged');
  }

  closeVisEditor(): void {
    const mod = this.visEditorOpen ? this.graph.modules.get(this.visEditorOpen) : null;
    if (mod && this.visEditorShrunkSize) {
      const prev = this.visEditorShrunkSize;
      if (prev.w === undefined) delete mod.w;
      else mod.w = prev.w;
      if (prev.h === undefined) delete mod.h;
      else mod.h = prev.h;
      this.emit('graphChanged');
    }
    this.visEditorShrunkSize = null;
    this.visEditorOpen = null;
    this.emit('visEditorChanged');
  }

  /**
   * Replace a container's nested visual graph. Undoable by default; pass
   * false during drag/slide gestures (snapshot once at gesture start).
   */
  setVisGraph(moduleId: string, graph: VisGraphData, undoable = true): void {
    const mod = this.graph.modules.get(moduleId);
    if (mod?.type !== 'visualizer') return;
    if (undoable) this.beginUndoable();
    mod.data = { ...mod.data, graph };
    this.emit('visGraphChanged');
  }

  /** Per-container display settings (frame-rate cap, resolution scale) — undoable. */
  setVisDisplay(moduleId: string, display: Partial<VisDisplay>): void {
    const mod = this.graph.modules.get(moduleId);
    if (mod?.type !== 'visualizer') return;
    this.beginUndoable();
    mod.data = { ...mod.data, ...display };
    this.emit('visGraphChanged');
  }

  /** Composer modules with the piano-roll editor open (module grown in place). */
  composerOpen = new Set<string>();
  /** Topmost/active panel — receives keyboard shortcuts, raised z-order. */
  composerActive: string | null = null;
  /** Compact tile sizes remembered across open ↔ shrink (per module). */
  private composerShrunkSize = new Map<string, { w?: number; h?: number }>();

  /** Tile size while the piano roll is open (world px, within def max clamp). */
  static readonly COMPOSER_OPEN_W = 720;
  static readonly COMPOSER_OPEN_H = 480;

  /** Container-tile 🤖: open the piano roll (growing it if needed) with its
   * AI popup up. The PianoRoll component consumes the request on mount/event. */
  composerAiRequest: string | null = null;

  requestComposerAi(moduleId: string): void {
    this.openComposer(moduleId);
    if (!this.composerOpen.has(moduleId)) return; // not a composer
    this.composerAiRequest = moduleId;
    this.emit('composerAiRequest');
  }

  openComposer(moduleId: string): void {
    const mod = this.graph.modules.get(moduleId);
    if (mod?.type !== 'composer') return;
    if (!this.composerOpen.has(moduleId)) {
      // Grow the tile so the roll has room; remember the compact size.
      this.composerShrunkSize.set(moduleId, { w: mod.w, h: mod.h });
      mod.w = Math.max(mod.w ?? 0, AppState.COMPOSER_OPEN_W);
      mod.h = Math.max(mod.h ?? 0, AppState.COMPOSER_OPEN_H);
    }
    this.composerOpen.add(moduleId);
    this.composerActive = moduleId;
    this.emit('composerChanged');
  }

  /** Shrink one editor back to the compact tile (or all when no id given). */
  closeComposer(moduleId?: string): void {
    const ids = moduleId === undefined ? [...this.composerOpen] : [moduleId];
    for (const id of ids) {
      if (!this.composerOpen.delete(id)) continue;
      const mod = this.graph.modules.get(id);
      const prev = this.composerShrunkSize.get(id);
      this.composerShrunkSize.delete(id);
      if (mod && prev) {
        if (prev.w === undefined) delete mod.w;
        else mod.w = prev.w;
        if (prev.h === undefined) delete mod.h;
        else mod.h = prev.h;
      }
    }
    if (moduleId === undefined || this.composerActive === moduleId) {
      this.composerActive = [...this.composerOpen][this.composerOpen.size - 1] ?? null;
    }
    this.emit('composerChanged');
  }

  /** Bring a panel to the front and make it the keyboard target. */
  raiseComposer(moduleId: string): void {
    if (this.composerActive === moduleId) return;
    this.composerActive = moduleId;
    this.emit('composerChanged');
  }

  /** Knob/Slider module shown in the range-config popup; null = closed. */
  rangeConfigOpen: string | null = null;

  openRangeConfig(moduleId: string): void {
    const type = this.graph.modules.get(moduleId)?.type;
    if (type !== 'knob' && type !== 'slider') return;
    this.rangeConfigOpen = moduleId;
    this.emit('rangeConfigChanged');
  }

  closeRangeConfig(): void {
    this.rangeConfigOpen = null;
    this.emit('rangeConfigChanged');
  }
  /** moduleId → performance.now() of last note-on, for data-wire pulses. */
  noteFlash = new Map<string, number>();
  /** Per-keyboard-module held voices: moduleId → (key → voiceId). */
  private heldVoices = new Map<string, Map<string, number>>();
  /**
   * Sample PCM keyed by owning module id — deliberately outside the graph
   * so undo snapshots stay small (see core/samples.ts).
   */
  readonly samples = new Map<string, SampleData>();

  selectedWireId: string | null = null;
  selectedModuleId: string | null = null;
  /** Multi-selection for grouping (shift-click / rubber band). */
  readonly selectedModuleIds = new Set<string>();
  readonly selectedGroupIds = new Set<string>();

  private listeners = new Map<StateEvent, Set<Listener>>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private static readonly UNDO_LIMIT = 100;

  /** Active recordings: moduleId → accumulated chunks. */
  private recordings = new Map<
    string,
    { chunksL: Float32Array[]; chunksR: Float32Array[]; samples: number; sampleRate: number }
  >();
  /** For UI + tests: last finished recording length in seconds. */
  lastRecordingSeconds = 0;

  constructor() {
    this.engine.onRecordData((data) => {
      const rec = this.recordings.get(data.moduleId);
      if (!rec) return;
      rec.chunksL.push(data.chL);
      rec.chunksR.push(data.chR);
      rec.samples += data.chL.length;
      rec.sampleRate = data.sampleRate;
    });
    this.engine.onMidiEvents((msg) => this.handleEngineMidi(msg.events));
    this.midi.onMessage((deviceId, data) => this.handleMidiMessage(deviceId, data));
    // Derived-tint sampling: the visual runtime averages frames for consumers.
    ContainerRenderer.tintWanted = (id) => this.tintSourceIds().has(id);
    ContainerRenderer.tintSink = (id, rgb) => this.pushTintSample(id, rgb);
    this.on('graphChanged', () => {
      this.tintSourcesCache = null;
    });
    this.engine.onStatus((status) => {
      this.meters = status.meters;
      this.seqSteps = status.seqSteps;
      this.controlValues = status.controlValues;
      this.gainReduction = status.gainReduction ?? {};
      this.spectra = status.spectra ?? {};
      this.visData = status.visData ?? {};
      for (const [id, feed] of Object.entries(this.visData)) this.visHub.pushStatus(id, feed);
      const now = performance.now();
      for (const id of status.noteActivity) this.noteFlash.set(id, now);
      this.transport.songPosition = status.songPosition;
      this.tickTextProducers(status.textNotes ?? {});
    });
  }

  /** Start the engine (user gesture required) and prime it with current state. */
  async ensureEngine(): Promise<void> {
    const wasRunning = this.engine.running;
    await this.engine.start();
    if (!wasRunning) {
      this.visHub.setSampleRate(this.engine.sampleRate);
      this.syncEngine();
      this.engine.sendTransport(this.transport, this.transport.songPosition);
      this.resendSamples();
    }
  }

  /**
   * Push the graph into the worklet and keep visual audio rings in step:
   * every visualizer gets a SAB ring (when the page is crossOriginIsolated;
   * otherwise the worklet falls back to status-message windows).
   */
  private syncEngine(): void {
    this.engine.syncGraph(this.graph);
    const live = new Set<string>();
    for (const mod of this.graph.modules.values()) {
      if (mod.type !== 'visualizer') continue;
      live.add(mod.id);
      if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated && !this.visHub.hasRing(mod.id)) {
        const sab = createVisRingBuffer();
        this.visHub.attachRing(mod.id, sab);
        this.engine.attachVisRing(mod.id, sab);
      }
    }
    this.visHub.prune(live);
    this.stt.prune(new Set(this.graph.modules.keys()));
  }

  // -- Samples ------------------------------------------------------------

  /** Push every stored sample whose module still exists into the worklet. */
  private resendSamples(): void {
    for (const [key, sample] of this.samples) {
      const { moduleId, pad } = parseSampleKey(key);
      if (!this.graph.modules.has(moduleId)) continue;
      this.engine.sendSample(moduleId, sample, pad);
    }
  }

  /** Install PCM into a Sample Voice module (UI file loads and tests land here). */
  setSample(moduleId: string, sample: SampleData, pad?: number): void {
    const mod = this.graph.modules.get(moduleId);
    if (!mod) return;
    this.samples.set(sampleKey(moduleId, pad), sample);
    mod.data = { ...mod.data, sampleName: sample.name };
    if (this.engine.running) {
      this.engine.sendSample(moduleId, sample, pad);
    }
    this.emit('sampleLoaded');
  }

  /** Decode a user-picked audio file and load it into a Sample Voice. */
  async loadSampleFile(moduleId: string, file: File, pad?: number): Promise<void> {
    await this.ensureEngine(); // file picker click is the user gesture
    const decoded = await this.engine.decode(await file.arrayBuffer());
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, decoded.numberOfChannels); c++) {
      channels.push(decoded.getChannelData(c).slice());
    }
    this.setSample(moduleId, { name: file.name, sampleRate: decoded.sampleRate, channels }, pad);
  }

  // -- Sample editor (PRD §8.2) --------------------------------------------

  /** Sample Editor target; null = closed. UI overlay watches 'editorChanged'. */
  editingSample: { moduleId: string; pad?: number } | null = null;

  openSampleEditor(moduleId: string, pad?: number): void {
    if (!this.samples.has(sampleKey(moduleId, pad))) return; // nothing to edit
    this.editingSample = { moduleId, pad };
    this.emit('editorChanged');
  }

  closeSampleEditor(): void {
    this.engine.stopPreview();
    this.editingSample = null;
    this.emit('editorChanged');
  }

  // -- MIDI (PRD §8.7 + MIDI learn) ------------------------------------------

  readonly midi = new MidiManager();
  /** Armed MIDI-learn target; the next CC received maps to it. */
  midiLearn: { moduleId: string; paramId: string } | null = null;
  /** "channel:cc" → param target. Saved with the project. */
  readonly midiMap = new Map<string, { moduleId: string; paramId: string }>();
  private clockTicks: number[] = [];

  armMidiLearn(moduleId: string, paramId: string): void {
    void this.midi.init();
    this.midiLearn = { moduleId, paramId };
    this.emit('midiChanged');
  }

  cancelMidiLearn(): void {
    this.midiLearn = null;
    this.emit('midiChanged');
  }

  private handleMidiMessage(deviceId: string, data: Uint8Array): void {
    if (data[0] >= 0xf8) {
      this.handleMidiClock(data[0]);
      return;
    }
    const status = data[0] & 0xf0;
    const channel = (data[0] & 0x0f) + 1;

    if (status === 0xb0) {
      // MIDI learn: capture the first CC that moves.
      if (this.midiLearn) {
        this.midiMap.set(`${channel}:${data[1]}`, this.midiLearn);
        this.midiLearn = null;
        this.emit('midiChanged');
      }
      const target = this.midiMap.get(`${channel}:${data[1]}`);
      if (target) {
        const mod = this.graph.modules.get(target.moduleId);
        const spec = mod
          ? this.graph.def(mod.type).params.find((p) => p.id === target.paramId)
          : undefined;
        if (spec) {
          this.setParam(target.moduleId, target.paramId, spec.min + (data[2] / 127) * (spec.max - spec.min));
        }
      }
    }

    for (const mod of this.graph.modules.values()) {
      if (mod.type !== 'midiIn') continue;
      const wantDevice = (mod.data?.deviceId as string) || '';
      if (wantDevice && wantDevice !== deviceId) continue;
      const chFilter = Math.round(mod.params.channel ?? 0);
      if (chFilter !== 0 && chFilter !== channel) continue;

      if (status === 0x90 && data[2] > 0) {
        this.noteOn(mod.id, `midi:${deviceId}:${data[1]}`, data[1], data[2] / 127);
      } else if (status === 0x80 || (status === 0x90 && data[2] === 0)) {
        this.noteOff(mod.id, `midi:${deviceId}:${data[1]}`);
      } else if (status === 0xb0 && data[1] === Math.round(mod.params.cc ?? 1)) {
        const v = data[2] / 127;
        this.controlValues[mod.id] = v; // immediate echo for wire glow
        if (this.engine.running) this.engine.sendControl(mod.id, v);
      }
    }
  }

  /** MIDI clock slave: 0xF8 tick (24 ppqn), 0xFA start, 0xFB continue, 0xFC stop. */
  private handleMidiClock(byte: number): void {
    const enabled = [...this.graph.modules.values()].some(
      (m) => m.type === 'midiIn' && Math.round(m.params.clock ?? 0) === 1,
    );
    if (!enabled) return;
    if (byte === 0xfa) {
      this.transportCommand('stop');
      this.transportCommand('play');
    } else if (byte === 0xfb) {
      this.transportCommand('play');
    } else if (byte === 0xfc) {
      this.transportCommand('stop');
    } else if (byte === 0xf8) {
      const now = performance.now();
      this.clockTicks.push(now);
      if (this.clockTicks.length > 25) this.clockTicks.shift();
      if (this.clockTicks.length === 25) {
        const msPerTick = (now - this.clockTicks[0]) / 24;
        const bpm = 60000 / (msPerTick * 24);
        if (Number.isFinite(bpm) && bpm >= 20 && bpm <= 300 && Math.abs(bpm - this.transport.tempo) > 0.5) {
          this.setTempo(bpm);
        }
      }
    }
  }

  /** Worklet-side MIDI Out events → actual MIDI bytes. */
  private handleEngineMidi(events: Array<{ moduleId: string; kind: string; pitch?: number; velocity?: number; value?: number }>): void {
    for (const ev of events) {
      const mod = this.graph.modules.get(ev.moduleId);
      if (!mod || mod.type !== 'midiOut') continue;
      const deviceId = (mod.data?.deviceId as string) || '';
      const ch = Math.min(15, Math.max(0, Math.round(mod.params.channel ?? 1) - 1));
      if (ev.kind === 'on') {
        this.midi.send(deviceId, [0x90 | ch, ev.pitch ?? 60, Math.round((ev.velocity ?? 1) * 127)]);
      } else if (ev.kind === 'off') {
        this.midi.send(deviceId, [0x80 | ch, ev.pitch ?? 60, 0]);
      } else if (ev.kind === 'cc') {
        this.midi.send(deviceId, [0xb0 | ch, Math.round(mod.params.cc ?? 1), ev.value ?? 0]);
      }
    }
  }


  on(event: StateEvent, fn: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => this.listeners.get(event)!.delete(fn);
  }

  private emit(event: StateEvent): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  // -- Undo / redo --------------------------------------------------------

  /**
   * Push an undo snapshot. Call BEFORE a user-visible mutation; for drag
   * gestures call once at gesture start so the whole drag is one undo step.
   */
  beginUndoable(): void {
    this.undoStack.push(this.serialize());
    if (this.undoStack.length > AppState.UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const snapshot = this.undoStack.pop();
    if (snapshot === undefined) return;
    this.redoStack.push(this.serialize());
    this.loadSnapshot(snapshot);
  }

  redo(): void {
    const snapshot = this.redoStack.pop();
    if (snapshot === undefined) return;
    this.undoStack.push(this.serialize());
    this.loadSnapshot(snapshot);
  }

  /** Restore graph state without touching the undo/redo stacks. */
  private loadSnapshot(json: string): void {
    const result = deserializeProject(json, MODULE_DEFS);
    const wasPlaying = this.transport.playing;
    this.graph = result.graph;
    this.projectName = result.name;
    this.transport = { ...result.transport, playing: wasPlaying };
    this.clearSelection();
    this.heldVoices.clear();
    this.restoreMidiMap(result.midiMap);
    this.syncEngine();
    // A module deleted then restored by undo gets a fresh worklet instance
    // with no PCM — push stored samples back in.
    if (this.engine.running) this.resendSamples();
    this.emit('projectLoaded');
    this.emit('graphChanged');
    this.emit('transportChanged');
  }

  // -- Structure --------------------------------------------------------

  addModule(type: string, x: number, y: number): ModuleInstance {
    this.beginUndoable();
    const inst = createInstance(this.graph.def(type), x, y);
    this.graph.addModule(inst);
    this.syncEngine();
    if (type === 'midiIn' || type === 'midiOut') void this.midi.init();
    this.emit('graphChanged');
    return inst;
  }

  removeModule(moduleId: string): void {
    this.beginUndoable();
    this.graph.removeModule(moduleId);
    if (this.selectedModuleId === moduleId) this.selectedModuleId = null;
    this.selectedModuleIds.delete(moduleId);
    this.syncEngine();
    this.emit('graphChanged');
  }

  connect(from: PortRef, to: PortRef): { ok: boolean; reason?: string; wire?: Wire } {
    const check = this.graph.canConnect(from, to);
    if (!check.ok) return { ok: false, reason: check.reason };
    this.beginUndoable();
    const result = this.graph.connect(from, to);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.syncEngine();
    this.emit('graphChanged');
    return { ok: true, wire: result.wire };
  }

  disconnect(wireId: string): void {
    this.beginUndoable();
    this.graph.disconnect(wireId);
    if (this.selectedWireId === wireId) this.selectedWireId = null;
    this.syncEngine();
    this.emit('graphChanged');
  }

  /**
   * Auto-wire the selected modules (toolbar): chain left-to-right, matching
   * free outputs to free inputs by type. Returns the number of wires added.
   */
  autoWireSelection(): number {
    const ids = [...this.selectedModuleIds].filter((id) => this.graph.modules.has(id));
    if (ids.length < 2) return 0;
    const plan = planAutoWire(this.graph, ids);
    if (plan.length === 0) return 0;
    this.beginUndoable();
    let added = 0;
    for (const p of plan) {
      if (this.graph.connect(p.from, p.to).ok) added++;
    }
    this.syncEngine();
    this.emit('graphChanged');
    return added;
  }

  // -- Groups (PRD §6) -----------------------------------------------------

  /** Group the current multi-selection. Returns the group, or null if <2 items. */
  groupSelection(): string | null {
    // Items must share one parent context — all top-level, or all directly
    // inside the SAME group. The new group nests inside that parent
    // (encapsulation: groups can contain groups).
    const moduleIds = [...this.selectedModuleIds].filter((id) => this.graph.modules.has(id));
    const groupIds = [...this.selectedGroupIds].filter((id) => this.graph.groups.has(id));
    if (moduleIds.length + groupIds.length < 2) return null;
    const parents = new Set<string | null>([
      ...moduleIds.map((id) => this.graph.groupOfModule(id)?.id ?? null),
      ...groupIds.map((id) => this.graph.parentGroup(id)?.id ?? null),
    ]);
    if (parents.size !== 1) return null; // can't group across boundaries
    const parentId = [...parents][0];
    this.beginUndoable();
    // Collapsed tile lands at the centroid of its members.
    let cx = 0;
    let cy = 0;
    for (const id of moduleIds) {
      const m = this.graph.modules.get(id)!;
      cx += m.x;
      cy += m.y;
    }
    for (const id of groupIds) {
      const g = this.graph.groups.get(id)!;
      cx += g.x;
      cy += g.y;
    }
    const n = moduleIds.length + groupIds.length;
    const group = this.graph.createGroup(`Group ${this.graph.groups.size + 1}`, moduleIds, groupIds, cx / n, cy / n);
    // Members leave their old parent; the new group takes their place in it.
    if (parentId) {
      const parent = this.graph.groups.get(parentId)!;
      parent.moduleIds = parent.moduleIds.filter((id) => !moduleIds.includes(id));
      parent.groupIds = parent.groupIds.filter((id) => !groupIds.includes(id));
      parent.groupIds.push(group.id);
    }
    this.clearSelection();
    this.selectedGroupIds.add(group.id);
    this.emit('graphChanged');
    this.emit('selectionChanged');
    return group.id;
  }

  ungroup(groupId: string): void {
    if (!this.graph.groups.has(groupId)) return;
    this.beginUndoable();
    this.graph.dissolveGroup(groupId);
    this.selectedGroupIds.delete(groupId);
    this.emit('graphChanged');
    this.emit('selectionChanged');
  }

  toggleGroupCollapsed(groupId: string): void {
    const group = this.graph.groups.get(groupId);
    if (!group) return;
    group.collapsed = !group.collapsed;
    this.emit('graphChanged');
  }

  renameGroup(groupId: string, name: string): void {
    const group = this.graph.groups.get(groupId);
    const trimmed = name.trim();
    if (!group || !trimmed || group.name === trimmed) return;
    this.beginUndoable();
    group.name = trimmed;
    this.emit('graphChanged');
  }

  recolorGroup(groupId: string, color: number | undefined): void {
    const group = this.graph.groups.get(groupId);
    if (!group) return;
    this.beginUndoable();
    group.color = color;
    this.emit('graphChanged');
  }

  // -- Module faces (design framework over groups) ---------------------------

  /**
   * Face image pixels (assetId → data URL) — outside the graph so undo
   * snapshots stay small (samples pattern); embedded in explicit saves.
   */
  readonly faceAssets = new Map<string, string>();
  private nextAssetId = 1;

  /** Group whose face is open in the editor; null = closed. */
  editingFaceGroupId: string | null = null;

  /** Armed face-learn: the next param row clicked inside the group binds. */
  faceLearn: { groupId: string } | null = null;
  /** Captured learn target, consumed by the editor. */
  faceLearnResult: { moduleId: string; paramId: string } | null = null;

  addFaceAsset(dataUrl: string): string {
    const id = `fa${this.nextAssetId++}`;
    this.faceAssets.set(id, dataUrl);
    return id;
  }

  /** Blank designable module (user flow: New Face → design → fill with modules). */
  newFaceModule(x: number, y: number): string {
    this.beginUndoable();
    const group = this.graph.createGroup(`Face ${this.graph.groups.size + 1}`, [], [], x, y);
    group.face = defaultFace();
    this.clearSelection();
    this.selectedGroupIds.add(group.id);
    this.emit('graphChanged');
    this.emit('selectionChanged');
    return group.id;
  }

  setGroupFace(groupId: string, face: FaceSpec): void {
    const group = this.graph.groups.get(groupId);
    if (!group) return;
    this.beginUndoable();
    pruneFaceBindings(this.graph, groupId, face);
    group.face = face;
    this.emit('graphChanged');
  }

  /** Hide a baseline group pole (key `moduleId:portId`). */
  hideGroupPole(groupId: string, key: string): void {
    const group = this.graph.groups.get(groupId);
    if (!group) return;
    this.beginUndoable();
    group.poleHidden = [...new Set([...(group.poleHidden ?? []), key])];
    group.poleAdded = (group.poleAdded ?? []).filter((k) => k !== key);
    this.emit('graphChanged');
  }

  /** Un-hide a baseline group pole. */
  showGroupPole(groupId: string, key: string): void {
    const group = this.graph.groups.get(groupId);
    if (!group) return;
    this.beginUndoable();
    group.poleHidden = (group.poleHidden ?? []).filter((k) => k !== key);
    this.emit('graphChanged');
  }

  /** Surface an extra member port as a pole (e.g. tap an internal output). */
  addGroupPole(groupId: string, key: string): void {
    const group = this.graph.groups.get(groupId);
    if (!group) return;
    this.beginUndoable();
    group.poleAdded = [...new Set([...(group.poleAdded ?? []), key])];
    group.poleHidden = (group.poleHidden ?? []).filter((k) => k !== key);
    this.emit('graphChanged');
  }

  /** Remove an explicitly-added group pole. */
  removeGroupPole(groupId: string, key: string): void {
    const group = this.graph.groups.get(groupId);
    if (!group) return;
    this.beginUndoable();
    group.poleAdded = (group.poleAdded ?? []).filter((k) => k !== key);
    this.emit('graphChanged');
  }

  openFaceEditor(groupId: string): void {
    if (!this.graph.groups.has(groupId)) return;
    this.editingFaceGroupId = groupId;
    this.emit('faceEditorChanged');
  }

  closeFaceEditor(): void {
    this.editingFaceGroupId = null;
    this.faceLearn = null;
    this.emit('faceEditorChanged');
  }

  /** Editor learn mode: expands the group so its param rows are clickable. */
  armFaceLearn(groupId: string): void {
    const group = this.graph.groups.get(groupId);
    if (!group) return;
    if (group.collapsed) {
      group.collapsed = false;
      this.emit('graphChanged');
    }
    this.faceLearn = { groupId };
    this.faceLearnResult = null;
    this.emit('faceLearnChanged');
  }

  cancelFaceLearn(): void {
    this.faceLearn = null;
    this.emit('faceLearnChanged');
  }

  /** Called by param rows on click while learn is armed. True = consumed. */
  completeFaceLearn(moduleId: string, paramId: string): boolean {
    if (!this.faceLearn) return false;
    if (!this.graph.modulesInGroup(this.faceLearn.groupId).has(moduleId)) return false;
    this.faceLearn = null;
    this.faceLearnResult = { moduleId, paramId };
    this.emit('faceLearnChanged');
    return true;
  }

  /** Export a faced group as a reusable .kkmod custom module. */
  exportFaceGroup(groupId: string): string {
    return exportKkmod(this.graph, groupId, this.faceAssets);
  }

  /** Insert a .kkmod as a collapsed faced group. One undo step. */
  importFaceGroup(text: string, origin: { x: number; y: number } = { x: 0, y: 0 }): {
    ok: boolean;
    errors: string[];
    warnings: string[];
    groupId?: string;
  } {
    let imported;
    try {
      imported = importKkmod(text, MODULE_DEFS);
    } catch (err) {
      return { ok: false, errors: [String(err instanceof Error ? err.message : err)], warnings: [] };
    }
    this.beginUndoable();

    // Re-key assets into this project's store.
    const assetMap = new Map<string, string>();
    for (const [oldId, dataUrl] of Object.entries(imported.assets)) {
      assetMap.set(oldId, this.addFaceAsset(dataUrl));
    }

    const xs = imported.modules.map((m) => m.x);
    const ys = imported.modules.map((m) => m.y);
    const minX = xs.length ? Math.min(...xs) : 0;
    const minY = ys.length ? Math.min(...ys) : 0;
    for (const inst of imported.modules) {
      inst.x = origin.x + (inst.x - minX) - 200;
      inst.y = origin.y + (inst.y - minY) - 150;
      this.graph.addModule(inst);
    }
    const warnings = [...imported.warnings];
    for (const w of imported.wires) {
      const res = this.graph.connect(w.from, w.to);
      if (!res.ok) warnings.push(`Wire dropped: ${res.reason}`);
    }
    for (const g of imported.groups) {
      if (g.face) {
        if (g.face.bgAssetId) g.face.bgAssetId = assetMap.get(g.face.bgAssetId);
        for (const el of g.face.elements) {
          if (el.assetId) el.assetId = assetMap.get(el.assetId);
        }
      }
      if (g.id === imported.rootGroupId) {
        g.x = origin.x;
        g.y = origin.y;
      }
      this.graph.groups.set(g.id, g);
    }

    this.syncEngine();
    this.clearSelection();
    this.selectedGroupIds.add(imported.rootGroupId);
    this.emit('graphChanged');
    this.emit('selectionChanged');
    return { ok: true, errors: [], warnings, groupId: imported.rootGroupId };
  }

  /** Group a selected module belongs to, for the toolbar Shrink button. */
  shrinkableGroupId(): string | null {
    for (const id of this.selectedGroupIds) {
      const g = this.graph.groups.get(id);
      if (g && !g.collapsed) return id;
    }
    if (this.selectedModuleId) {
      const g = this.graph.groupOfModule(this.selectedModuleId);
      if (g && !g.collapsed) return g.id;
    }
    return null;
  }

  /** Pull an expanded group back into its (faced) tile. */
  shrinkSelection(): void {
    const id = this.shrinkableGroupId();
    if (!id) return;
    const group = this.graph.groups.get(id)!;
    group.collapsed = true;
    this.clearSelection();
    this.selectedGroupIds.add(id);
    this.emit('graphChanged');
    this.emit('selectionChanged');
  }

  setParam(moduleId: string, paramId: string, value: number): void {
    const mod = this.graph.modules.get(moduleId);
    if (!mod) return;
    mod.params[paramId] = value;
    this.engine.setParam(moduleId, paramId, value);
    if (mod.type === 'transport' && paramId === 'tempo') {
      this.transport.tempo = value;
      this.engine.sendTransport(this.transport);
      this.emit('transportChanged');
    }
    this.emit('paramChanged');
  }

  /** Update one key of a module's data blob (e.g. sequencer steps). */
  setModuleData(moduleId: string, key: string, value: unknown): void {
    const mod = this.graph.modules.get(moduleId);
    if (!mod) return;
    mod.data = { ...mod.data, [key]: value };
    this.engine.setData(moduleId, key, value);
  }

  // -- AI patch import (PRD §10.2) -------------------------------------------

  /**
   * Validate and insert an AI-written .kkgroup. Structural errors abort with
   * nothing touched; the inserted modules arrive as a selected Module Group.
   * One undo step.
   */
  importAiPatch(
    text: string,
    origin: { x: number; y: number } = { x: 0, y: 0 },
  ): { ok: boolean; errors: string[]; warnings: string[]; groupId?: string; moduleIds: string[] } {
    const result = parseKkGroup(text, MODULE_DEFS);
    if (!result.ok || !result.patch) {
      return { ok: false, errors: result.errors, warnings: result.warnings, moduleIds: [] };
    }
    const patch = result.patch;
    const warnings = [...result.warnings];
    this.beginUndoable();

    // AI positions are hints only (PRD §10.2): use them when they spread out,
    // otherwise grid-place; the canvas collision resolver handles the rest.
    const xs = patch.modules.map((m) => m.x);
    const ys = patch.modules.map((m) => m.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const useHints = Math.max(...xs) - minX + (Math.max(...ys) - minY) > 100;

    const idMap = new Map<string, string>();
    patch.modules.forEach((m, i) => {
      const pos = useHints
        ? { x: origin.x + (m.x - minX) - 300, y: origin.y + (m.y - minY) - 200 }
        : { x: origin.x + (i % 3) * 320 - 320, y: origin.y + Math.floor(i / 3) * 300 - 150 };
      const inst = createInstance(this.graph.def(m.type), pos.x, pos.y);
      inst.params = { ...inst.params, ...m.params };
      if (m.data) inst.data = { ...inst.data, ...m.data };
      if (m.label) inst.label = m.label;
      this.graph.addModule(inst);
      idMap.set(m.id, inst.id);
    });

    for (const w of patch.wires) {
      const res = this.graph.connect(
        { moduleId: idMap.get(w.from.module)!, portId: w.from.port },
        { moduleId: idMap.get(w.to.module)!, portId: w.to.port },
      );
      if (!res.ok) {
        warnings.push(`Wire ${w.from.module}.${w.from.port} → ${w.to.module}.${w.to.port} dropped: ${res.reason}`);
      }
    }

    const group = this.graph.createGroup(patch.name, [...idMap.values()], [], origin.x, origin.y);

    // Optional AI-designed front panel (PRD §6/§10): remap element bindings from
    // the patch's own ids to the real instance ids, prune any that don't resolve,
    // and collapse so the face is shown as a finished module.
    if (patch.face) {
      const face = {
        ...patch.face,
        elements: patch.face.elements.map((el) => ({
          ...el,
          moduleId: el.moduleId ? idMap.get(el.moduleId) : undefined,
          moduleId2: el.moduleId2 ? idMap.get(el.moduleId2) : undefined,
        })),
      };
      pruneFaceBindings(this.graph, group.id, face);
      group.face = face;
      group.collapsed = true;
    }

    this.syncEngine();
    this.clearSelection();
    this.selectedGroupIds.add(group.id);
    this.emit('graphChanged');
    this.emit('selectionChanged');
    return { ok: true, errors: [], warnings, groupId: group.id, moduleIds: [...idMap.values()] };
  }

  /**
   * AI edit of an existing group (container 🤖 button): validate a .kkgroup
   * reply and swap the group's contents in place — same group id, tile
   * position, and color, so intrinsic-pole wires and canvas placement survive.
   * External wires reconnect to module ids the model kept (the group context
   * tells it to keep them); the rest drop with warnings. One undo step.
   */
  replaceAiGroup(
    groupId: string,
    text: string,
  ): { ok: boolean; errors: string[]; warnings: string[]; groupId?: string; moduleIds: string[] } {
    const group = this.graph.groups.get(groupId);
    if (!group) return { ok: false, errors: ['The group no longer exists.'], warnings: [], moduleIds: [] };
    const result = parseKkGroup(text, MODULE_DEFS);
    if (!result.ok || !result.patch) {
      return { ok: false, errors: result.errors, warnings: result.warnings, moduleIds: [] };
    }
    const patch = result.patch;
    const warnings = [...result.warnings];
    this.beginUndoable();

    // Record wires crossing the boundary by inner module id + port; they are
    // reconnected after the swap wherever the model kept the id.
    const members = this.graph.modulesInGroup(groupId);
    const external: Array<{ outside: PortRef; insideId: string; insidePort: string; toInside: boolean }> = [];
    for (const w of this.graph.wires.values()) {
      const fromIn = members.has(w.from.moduleId);
      const toIn = members.has(w.to.moduleId);
      if (fromIn === toIn) continue;
      external.push(
        fromIn
          ? { outside: w.to, insideId: w.from.moduleId, insidePort: w.from.portId, toInside: false }
          : { outside: w.from, insideId: w.to.moduleId, insidePort: w.to.portId, toInside: true },
      );
    }

    // Drop the old contents: member modules (their wires go too) and nested
    // child groups. The group object itself survives.
    for (const id of members) this.graph.removeModule(id);
    const dropGroups = (id: string) => {
      const grp = this.graph.groups.get(id);
      if (!grp) return;
      for (const child of grp.groupIds) dropGroups(child);
      if (id !== groupId) this.graph.groups.delete(id);
    };
    dropGroups(groupId);
    group.groupIds = [];

    // Insert the new contents around the tile (importAiPatch layout rules).
    const xs = patch.modules.map((m) => m.x);
    const ys = patch.modules.map((m) => m.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const useHints = Math.max(...xs) - minX + (Math.max(...ys) - minY) > 100;
    const idMap = new Map<string, string>();
    patch.modules.forEach((m, i) => {
      const pos = useHints
        ? { x: group.x + (m.x - minX), y: group.y + (m.y - minY) }
        : { x: group.x + (i % 3) * 320, y: group.y + Math.floor(i / 3) * 300 };
      const inst = createInstance(this.graph.def(m.type), pos.x, pos.y);
      inst.params = { ...inst.params, ...m.params };
      if (m.data) inst.data = { ...inst.data, ...m.data };
      if (m.label) inst.label = m.label;
      this.graph.addModule(inst);
      idMap.set(m.id, inst.id);
    });
    group.moduleIds = [...idMap.values()];
    group.name = patch.name;

    for (const w of patch.wires) {
      const res = this.graph.connect(
        { moduleId: idMap.get(w.from.module)!, portId: w.from.port },
        { moduleId: idMap.get(w.to.module)!, portId: w.to.port },
      );
      if (!res.ok) {
        warnings.push(`Wire ${w.from.module}.${w.from.port} → ${w.to.module}.${w.to.port} dropped: ${res.reason}`);
      }
    }

    for (const ext of external) {
      const inner = idMap.get(ext.insideId);
      if (!inner) {
        warnings.push(`External wire to ${ext.insideId}.${ext.insidePort} dropped: the module was removed.`);
        continue;
      }
      const innerRef = { moduleId: inner, portId: ext.insidePort };
      const res = ext.toInside
        ? this.graph.connect(ext.outside, innerRef)
        : this.graph.connect(innerRef, ext.outside);
      if (!res.ok) warnings.push(`External wire to ${ext.insideId}.${ext.insidePort} dropped: ${res.reason}`);
    }

    // Face: a reply face replaces the old one (bindings remapped to the new
    // instance ids); no reply face keeps the old layout minus dead bindings.
    const remapFace = (face: FaceSpec): FaceSpec => ({
      ...face,
      elements: face.elements.map((el) => ({
        ...el,
        moduleId: el.moduleId ? idMap.get(el.moduleId) : undefined,
        moduleId2: el.moduleId2 ? idMap.get(el.moduleId2) : undefined,
      })),
    });
    if (patch.face) {
      const face = remapFace(patch.face);
      pruneFaceBindings(this.graph, groupId, face);
      group.face = face;
      group.collapsed = true;
    } else if (group.face) {
      const face = remapFace(group.face);
      pruneFaceBindings(this.graph, groupId, face);
      group.face = face;
    }

    this.syncEngine();
    this.clearSelection();
    this.selectedGroupIds.add(groupId);
    this.emit('graphChanged');
    this.emit('selectionChanged');
    return { ok: true, errors: [], warnings, groupId, moduleIds: [...idMap.values()] };
  }

  // -- AI project import (whole-project generation) ---------------------------

  /**
   * Validate an AI-written .kkproject and REPLACE the current project with it:
   * fresh graph, nested groups, tempo, composer clips riding in module data.
   * Structural errors abort with nothing touched. One undo step restores the
   * previous project (sample PCM stays in this.samples, so undo re-links it).
   */
  importAiProject(text: string): { ok: boolean; errors: string[]; warnings: string[] } {
    const result = parseKkProject(text, MODULE_DEFS);
    if (!result.ok || !result.project) {
      return { ok: false, errors: result.errors, warnings: result.warnings };
    }
    const project = result.project;
    const warnings = [...result.warnings];
    this.beginUndoable();

    this.graph = new Graph(MODULE_DEFS);

    // AI positions are hints: use them when they spread out, otherwise grid.
    const xs = project.modules.map((m) => m.x);
    const ys = project.modules.map((m) => m.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const useHints = Math.max(...xs) - minX + (Math.max(...ys) - minY) > 100;

    const idMap = new Map<string, string>();
    project.modules.forEach((m, i) => {
      const pos = useHints
        ? { x: m.x - minX, y: m.y - minY }
        : { x: (i % 4) * 320, y: Math.floor(i / 4) * 300 };
      const inst = createInstance(this.graph.def(m.type), pos.x, pos.y);
      inst.params = { ...inst.params, ...m.params };
      if (m.data) inst.data = { ...inst.data, ...m.data };
      if (m.label) inst.label = m.label;
      this.graph.addModule(inst);
      idMap.set(m.id, inst.id);
    });

    for (const w of project.wires) {
      const res = this.graph.connect(
        { moduleId: idMap.get(w.from.module)!, portId: w.from.port },
        { moduleId: idMap.get(w.to.module)!, portId: w.to.port },
      );
      if (!res.ok) {
        warnings.push(`Wire ${w.from.module}.${w.from.port} → ${w.to.module}.${w.to.port} dropped: ${res.reason}`);
      }
    }

    // Groups, children before parents so child ids resolve (nesting).
    const byId = new Map(project.groups.map((g) => [g.id, g]));
    const gidMap = new Map<string, string>();
    const make = (g: KkProjectGroup): string => {
      const made = gidMap.get(g.id);
      if (made) return made;
      const childIds = g.groupIds.map((cid) => make(byId.get(cid)!));
      const memberIds = g.moduleIds.map((mid) => idMap.get(mid)!);
      // Tile lands at the centroid of every module inside, nested included.
      const all = [...this.collectModules(g, byId)].map((mid) => this.graph.modules.get(idMap.get(mid)!)!);
      const cx = all.length ? all.reduce((s, m) => s + m.x, 0) / all.length : 0;
      const cy = all.length ? all.reduce((s, m) => s + m.y, 0) / all.length : 0;
      const group = this.graph.createGroup(g.name, memberIds, childIds, cx, cy);
      group.collapsed = g.collapsed;
      // AI-designed front panel: remap bindings to real instance ids and
      // prune any that don't resolve (same shape as importAiPatch).
      if (g.face) {
        const face = {
          ...g.face,
          elements: g.face.elements.map((el) => ({
            ...el,
            moduleId: el.moduleId ? idMap.get(el.moduleId) : undefined,
            moduleId2: el.moduleId2 ? idMap.get(el.moduleId2) : undefined,
          })),
        };
        pruneFaceBindings(this.graph, group.id, face);
        group.face = face;
      }
      gidMap.set(g.id, group.id);
      return group.id;
    };
    for (const g of project.groups) make(g);

    this.projectName = project.name;
    this.transport.tempo = project.tempo;
    this.transport.songPosition = 0;
    this.clearSelection();
    this.heldVoices.clear();
    this.syncEngine();
    this.engine.sendTransport(this.transport, 0);
    this.emit('projectLoaded');
    this.emit('graphChanged');
    this.emit('transportChanged');
    this.emit('selectionChanged');
    return { ok: true, errors: [], warnings };
  }

  /** All module ids inside a parsed project group, nested children included. */
  private collectModules(g: KkProjectGroup, byId: Map<string, KkProjectGroup>): Set<string> {
    const out = new Set<string>(g.moduleIds);
    for (const cid of g.groupIds) {
      for (const m of this.collectModules(byId.get(cid)!, byId)) out.add(m);
    }
    return out;
  }

  // -- Selection --------------------------------------------------------

  clearSelection(): void {
    this.selectedWireId = null;
    this.selectedModuleId = null;
    this.selectedModuleIds.clear();
    this.selectedGroupIds.clear();
  }

  select(target: { wireId?: string; moduleId?: string; groupId?: string } | null): void {
    this.clearSelection();
    if (target?.wireId) this.selectedWireId = target.wireId;
    if (target?.moduleId) {
      this.selectedModuleId = target.moduleId;
      this.selectedModuleIds.add(target.moduleId);
    }
    if (target?.groupId) this.selectedGroupIds.add(target.groupId);
    this.emit('selectionChanged');
  }

  /** Shift-click / rubber band: toggle or add without clearing. */
  addToSelection(target: { moduleId?: string; groupId?: string }, toggle = false): void {
    this.selectedWireId = null;
    if (target.moduleId) {
      if (toggle && this.selectedModuleIds.has(target.moduleId)) {
        this.selectedModuleIds.delete(target.moduleId);
      } else {
        this.selectedModuleIds.add(target.moduleId);
      }
      this.selectedModuleId = target.moduleId;
    }
    if (target.groupId) {
      if (toggle && this.selectedGroupIds.has(target.groupId)) {
        this.selectedGroupIds.delete(target.groupId);
      } else {
        this.selectedGroupIds.add(target.groupId);
      }
    }
    this.emit('selectionChanged');
  }

  deleteSelection(): void {
    if (this.selectedWireId) {
      this.disconnect(this.selectedWireId);
      return;
    }
    if (this.selectedModuleIds.size === 0 && this.selectedGroupIds.size === 0) return;
    this.beginUndoable();
    // Deleting a group deletes its members (wires go with them).
    const doomed = new Set<string>(this.selectedModuleIds);
    const doomedGroups = new Set<string>();
    for (const gid of this.selectedGroupIds) {
      for (const m of this.graph.modulesInGroup(gid)) doomed.add(m);
      const g = this.graph.groups.get(gid);
      const dropGroups = (id: string) => {
        const grp = this.graph.groups.get(id);
        if (!grp) return;
        for (const child of grp.groupIds) dropGroups(child);
        this.graph.groups.delete(id);
        doomedGroups.add(id);
      };
      if (g) dropGroups(gid);
    }
    for (const id of doomed) this.graph.removeModule(id);
    // Wires ending on a deleted group's intrinsic poles die with the group.
    for (const w of [...this.graph.wires.values()]) {
      if (doomedGroups.has(w.from.moduleId) || doomedGroups.has(w.to.moduleId)) {
        this.graph.wires.delete(w.id);
      }
    }
    this.clearSelection();
    this.syncEngine();
    this.emit('graphChanged');
    this.emit('selectionChanged');
  }

  // -- Notes (keyboard modules) ------------------------------------------

  /** key: stable identifier for the held note (e.g. "kbd:60" or "qwerty:a"). */
  noteOn(sourceModuleId: string, key: string, pitch: number, velocity = 0.9): void {
    void this.ensureEngine();
    const held = this.heldVoices.get(sourceModuleId) ?? new Map<string, number>();
    this.heldVoices.set(sourceModuleId, held);
    if (held.has(key)) return; // key repeat
    const voiceId = this.engine.allocVoiceId();
    held.set(key, voiceId);
    this.engine.noteOn(this.graph, sourceModuleId, voiceId, pitch, velocity);
    this.noteFlash.set(sourceModuleId, performance.now());
  }

  noteOff(sourceModuleId: string, key: string): void {
    const held = this.heldVoices.get(sourceModuleId);
    const voiceId = held?.get(key);
    if (voiceId === undefined) return;
    held!.delete(key);
    this.engine.noteOff(this.graph, sourceModuleId, voiceId);
  }

  // -- Recording (PRD §8.7) -------------------------------------------------

  isRecording(moduleId: string): boolean {
    return this.recordings.has(moduleId);
  }

  recordingSeconds(moduleId: string): number {
    const rec = this.recordings.get(moduleId);
    return rec ? rec.samples / rec.sampleRate : 0;
  }

  toggleRecord(moduleId: string): void {
    if (this.recordings.has(moduleId)) {
      this.finishRecording(moduleId);
      return;
    }
    void this.ensureEngine().then(() => {
      this.recordings.set(moduleId, { chunksL: [], chunksR: [], samples: 0, sampleRate: 48000 });
      this.engine.recordStart(moduleId);
    });
  }

  private finishRecording(moduleId: string): void {
    this.engine.recordStop(moduleId);
    // Give the final flush a moment to arrive before assembling the file.
    setTimeout(() => {
      const rec = this.recordings.get(moduleId);
      this.recordings.delete(moduleId);
      if (!rec || rec.samples === 0) return;
      const chL = new Float32Array(rec.samples);
      const chR = new Float32Array(rec.samples);
      let offset = 0;
      for (let i = 0; i < rec.chunksL.length; i++) {
        chL.set(rec.chunksL[i], offset);
        chR.set(rec.chunksR[i], offset);
        offset += rec.chunksL[i].length;
      }
      this.lastRecordingSeconds = rec.samples / rec.sampleRate;
      const blob = encodeWav(chL, chR, rec.sampleRate);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = URL.createObjectURL(blob);
      a.download = `${this.projectName}-${stamp}.wav`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, 150);
  }

  // -- Transport ---------------------------------------------------------

  transportCommand(cmd: 'play' | 'stop' | 'pause' | 'rewind'): void {
    let jumpTo: number | undefined;
    if (cmd === 'play') this.transport.playing = true;
    if (cmd === 'pause') this.transport.playing = false;
    if (cmd === 'stop') {
      // Stop pressed while already stopped = panic: cut all audio, including
      // self-sustaining feedback loops and reverb/delay tails.
      if (!this.transport.playing && this.engine.running) this.engine.panic();
      this.transport.playing = false;
      jumpTo = 0;
    }
    if (cmd === 'rewind') jumpTo = 0;
    if (jumpTo !== undefined) this.transport.songPosition = jumpTo;
    // ensureEngine sends the initial transport itself on first start.
    if (this.engine.running) this.engine.sendTransport(this.transport, jumpTo);
    else void this.ensureEngine();
    this.emit('transportChanged');
  }

  setTempo(tempo: number): void {
    this.transport.tempo = Math.min(300, Math.max(20, tempo));
    for (const m of this.graph.modules.values()) {
      if (m.type === 'transport') m.params.tempo = this.transport.tempo;
    }
    this.engine.sendTransport(this.transport);
    this.emit('transportChanged');
    this.emit('paramChanged');
  }

  // -- Project -----------------------------------------------------------

  private midiMapObject(): Record<string, { moduleId: string; paramId: string }> | undefined {
    return this.midiMap.size > 0 ? Object.fromEntries(this.midiMap) : undefined;
  }

  private restoreMidiMap(map: Record<string, { moduleId: string; paramId: string }>): void {
    this.midiMap.clear();
    for (const [key, target] of Object.entries(map)) this.midiMap.set(key, target);
  }

  /** Undo snapshots: graph only, no sample PCM. */
  serialize(): string {
    return serializeProject(this.projectName, this.graph, this.transport, undefined, this.midiMapObject());
  }

  /** Explicit project save: embeds sample PCM + face assets for portability (PRD §15). */
  serializeWithSamples(): string {
    const samples = [...this.samples.entries()]
      .map(([key, sample]) => ({ ...parseSampleKey(key), sample }))
      .filter(({ moduleId }) => this.graph.modules.has(moduleId))
      .map(({ moduleId, pad, sample }) => encodeSample(moduleId, sample, pad));
    // Only assets still referenced by some face.
    const referenced = new Set<string>();
    for (const g of this.graph.groups.values()) {
      if (g.face?.bgAssetId) referenced.add(g.face.bgAssetId);
      for (const el of g.face?.elements ?? []) {
        if (el.assetId) referenced.add(el.assetId);
      }
    }
    const faceAssets: Record<string, string> = {};
    for (const id of referenced) {
      const url = this.faceAssets.get(id);
      if (url) faceAssets[id] = url;
    }
    return serializeProject(
      this.projectName, this.graph, this.transport, samples, this.midiMapObject(), faceAssets,
    );
  }

  loadProject(json: string): string[] {
    this.undoStack = [];
    this.redoStack = [];
    const result = deserializeProject(json, MODULE_DEFS);
    this.graph = result.graph;
    this.projectName = result.name;
    this.transport = result.transport;
    this.selectedModuleId = null;
    this.selectedWireId = null;
    this.heldVoices.clear();
    this.samples.clear();
    this.faceAssets.clear();
    for (const [id, url] of Object.entries(result.faceAssets)) {
      this.faceAssets.set(id, url);
      const n = Number(id.replace(/^fa/, ''));
      if (Number.isFinite(n) && n >= this.nextAssetId) this.nextAssetId = n + 1;
    }
    this.restoreMidiMap(result.midiMap);
    if ([...this.graph.modules.values()].some((m) => m.type === 'midiIn' || m.type === 'midiOut')) {
      void this.midi.init();
    }
    this.syncEngine();
    this.engine.sendTransport(this.transport, 0);
    for (const raw of result.samples) {
      const sample = decodeSample(raw);
      this.samples.set(sampleKey(raw.moduleId, raw.pad), sample);
      if (this.engine.running) {
        this.engine.sendSample(raw.moduleId, sample, raw.pad);
      }
    }
    this.emit('projectLoaded');
    this.emit('graphChanged');
    this.emit('transportChanged');
    this.emit('sampleLoaded');
    return result.warnings;
  }
}

export const appState = new AppState();
