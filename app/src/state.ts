/**
 * Central app state: the patch graph, the audio engine, transport, selection,
 * and live meter/note-activity data the canvas reads each frame.
 * Plain event-emitter pattern so both Pixi code and Svelte chrome can listen.
 */

import { Graph, type PortRef, type Wire } from './core/graph';
import { createInstance, type ModuleInstance } from './core/module';
import { MODULE_DEFS } from './core/registry';
import { decodeSample, encodeSample, type SampleData } from './core/samples';
import { deserializeProject, serializeProject } from './core/serialize';
import { DEFAULT_TRANSPORT, type TransportState } from './core/types';
import { Engine } from './engine/engine';
import type { MeterReading } from './engine/messages';

export type StateEvent =
  | 'graphChanged' // modules/wires added or removed — structural
  | 'paramChanged'
  | 'transportChanged'
  | 'selectionChanged'
  | 'projectLoaded'
  | 'sampleLoaded';

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

  constructor() {
    this.engine.onStatus((status) => {
      this.meters = status.meters;
      this.seqSteps = status.seqSteps;
      this.controlValues = status.controlValues;
      const now = performance.now();
      for (const id of status.noteActivity) this.noteFlash.set(id, now);
      this.transport.songPosition = status.songPosition;
    });
  }

  /** Start the engine (user gesture required) and prime it with current state. */
  async ensureEngine(): Promise<void> {
    const wasRunning = this.engine.running;
    await this.engine.start();
    if (!wasRunning) {
      this.engine.syncGraph(this.graph);
      this.engine.sendTransport(this.transport, this.transport.songPosition);
      for (const [moduleId, sample] of this.samples) {
        this.engine.sendSample(moduleId, sample.sampleRate, sample.channels);
      }
    }
  }

  // -- Samples ------------------------------------------------------------

  /** Install PCM into a sampler module (UI file loads and tests both land here). */
  setSample(moduleId: string, sample: SampleData): void {
    const mod = this.graph.modules.get(moduleId);
    if (!mod) return;
    this.samples.set(moduleId, sample);
    mod.data = { ...mod.data, sampleName: sample.name };
    if (this.engine.running) {
      this.engine.sendSample(moduleId, sample.sampleRate, sample.channels);
    }
    this.emit('sampleLoaded');
  }

  /** Decode a user-picked audio file and load it into a sampler. */
  async loadSampleFile(moduleId: string, file: File): Promise<void> {
    await this.ensureEngine(); // file picker click is the user gesture
    const decoded = await this.engine.decode(await file.arrayBuffer());
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, decoded.numberOfChannels); c++) {
      channels.push(decoded.getChannelData(c).slice());
    }
    this.setSample(moduleId, { name: file.name, sampleRate: decoded.sampleRate, channels });
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
    this.engine.syncGraph(this.graph);
    this.emit('projectLoaded');
    this.emit('graphChanged');
    this.emit('transportChanged');
  }

  // -- Structure --------------------------------------------------------

  addModule(type: string, x: number, y: number): ModuleInstance {
    this.beginUndoable();
    const inst = createInstance(this.graph.def(type), x, y);
    this.graph.addModule(inst);
    this.engine.syncGraph(this.graph);
    this.emit('graphChanged');
    return inst;
  }

  removeModule(moduleId: string): void {
    this.beginUndoable();
    this.graph.removeModule(moduleId);
    if (this.selectedModuleId === moduleId) this.selectedModuleId = null;
    this.selectedModuleIds.delete(moduleId);
    this.engine.syncGraph(this.graph);
    this.emit('graphChanged');
  }

  connect(from: PortRef, to: PortRef): { ok: boolean; reason?: string; wire?: Wire } {
    const check = this.graph.canConnect(from, to);
    if (!check.ok) return { ok: false, reason: check.reason };
    this.beginUndoable();
    const result = this.graph.connect(from, to);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.engine.syncGraph(this.graph);
    this.emit('graphChanged');
    return { ok: true, wire: result.wire };
  }

  disconnect(wireId: string): void {
    this.beginUndoable();
    this.graph.disconnect(wireId);
    if (this.selectedWireId === wireId) this.selectedWireId = null;
    this.engine.syncGraph(this.graph);
    this.emit('graphChanged');
  }

  // -- Groups (PRD §6) -----------------------------------------------------

  /** Group the current multi-selection. Returns the group, or null if <2 items. */
  groupSelection(): string | null {
    // Only top-level items (no parent group) can be grouped together.
    const moduleIds = [...this.selectedModuleIds].filter(
      (id) => this.graph.modules.has(id) && !this.graph.groupOfModule(id),
    );
    const groupIds = [...this.selectedGroupIds].filter(
      (id) => this.graph.groups.has(id) && !this.graph.parentGroup(id),
    );
    if (moduleIds.length + groupIds.length < 2) return null;
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
    for (const gid of this.selectedGroupIds) {
      for (const m of this.graph.modulesInGroup(gid)) doomed.add(m);
      const g = this.graph.groups.get(gid);
      const dropGroups = (id: string) => {
        const grp = this.graph.groups.get(id);
        if (!grp) return;
        for (const child of grp.groupIds) dropGroups(child);
        this.graph.groups.delete(id);
      };
      if (g) dropGroups(gid);
    }
    for (const id of doomed) this.graph.removeModule(id);
    this.clearSelection();
    this.engine.syncGraph(this.graph);
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

  // -- Transport ---------------------------------------------------------

  transportCommand(cmd: 'play' | 'stop' | 'pause' | 'rewind'): void {
    let jumpTo: number | undefined;
    if (cmd === 'play') this.transport.playing = true;
    if (cmd === 'pause') this.transport.playing = false;
    if (cmd === 'stop') {
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

  /** Undo snapshots: graph only, no sample PCM. */
  serialize(): string {
    return serializeProject(this.projectName, this.graph, this.transport);
  }

  /** Explicit project save: embeds sample PCM for portability (PRD §15). */
  serializeWithSamples(): string {
    const samples = [...this.samples.entries()]
      .filter(([moduleId]) => this.graph.modules.has(moduleId))
      .map(([moduleId, sample]) => encodeSample(moduleId, sample));
    return serializeProject(this.projectName, this.graph, this.transport, samples);
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
    this.engine.syncGraph(this.graph);
    this.engine.sendTransport(this.transport, 0);
    for (const raw of result.samples) {
      const sample = decodeSample(raw);
      this.samples.set(raw.moduleId, sample);
      if (this.engine.running) {
        this.engine.sendSample(raw.moduleId, sample.sampleRate, sample.channels);
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
