/**
 * Central app state: the patch graph, the audio engine, transport, selection,
 * and live meter/note-activity data the canvas reads each frame.
 * Plain event-emitter pattern so both Pixi code and Svelte chrome can listen.
 */

import { Graph, type PortRef, type Wire } from './core/graph';
import { createInstance, type ModuleInstance } from './core/module';
import { MODULE_DEFS } from './core/registry';
import { deserializeProject, serializeProject } from './core/serialize';
import { DEFAULT_TRANSPORT, type TransportState } from './core/types';
import { Engine } from './engine/engine';
import type { MeterReading } from './engine/messages';

export type StateEvent =
  | 'graphChanged' // modules/wires added or removed — structural
  | 'paramChanged'
  | 'transportChanged'
  | 'selectionChanged'
  | 'projectLoaded';

type Listener = () => void;

export class AppState {
  graph = new Graph(MODULE_DEFS);
  readonly engine = new Engine();
  transport: TransportState = { ...DEFAULT_TRANSPORT };
  projectName = 'Untitled';

  /** Live per-module meters from the engine, refreshed ~30 Hz. */
  meters: Record<string, MeterReading> = {};
  /** moduleId → performance.now() of last note-on, for data-wire pulses. */
  noteFlash = new Map<string, number>();
  /** Per-keyboard-module held voices: moduleId → (key → voiceId). */
  private heldVoices = new Map<string, Map<string, number>>();

  selectedWireId: string | null = null;
  selectedModuleId: string | null = null;

  private listeners = new Map<StateEvent, Set<Listener>>();

  constructor() {
    this.engine.onMeters((m) => {
      this.meters = m;
    });
  }

  on(event: StateEvent, fn: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => this.listeners.get(event)!.delete(fn);
  }

  private emit(event: StateEvent): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  // -- Structure --------------------------------------------------------

  addModule(type: string, x: number, y: number): ModuleInstance {
    const inst = createInstance(this.graph.def(type), x, y);
    this.graph.addModule(inst);
    this.engine.syncGraph(this.graph);
    this.emit('graphChanged');
    return inst;
  }

  removeModule(moduleId: string): void {
    this.graph.removeModule(moduleId);
    if (this.selectedModuleId === moduleId) this.selectedModuleId = null;
    this.engine.syncGraph(this.graph);
    this.emit('graphChanged');
  }

  connect(from: PortRef, to: PortRef): { ok: boolean; reason?: string; wire?: Wire } {
    const result = this.graph.connect(from, to);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.engine.syncGraph(this.graph);
    this.emit('graphChanged');
    return { ok: true, wire: result.wire };
  }

  disconnect(wireId: string): void {
    this.graph.disconnect(wireId);
    if (this.selectedWireId === wireId) this.selectedWireId = null;
    this.engine.syncGraph(this.graph);
    this.emit('graphChanged');
  }

  setParam(moduleId: string, paramId: string, value: number): void {
    const mod = this.graph.modules.get(moduleId);
    if (!mod) return;
    mod.params[paramId] = value;
    this.engine.setParam(moduleId, paramId, value);
    if (mod.type === 'transport' && paramId === 'tempo') {
      this.transport.tempo = value;
      this.emit('transportChanged');
    }
    this.emit('paramChanged');
  }

  // -- Selection --------------------------------------------------------

  select(target: { wireId?: string; moduleId?: string } | null): void {
    this.selectedWireId = target?.wireId ?? null;
    this.selectedModuleId = target?.moduleId ?? null;
    this.emit('selectionChanged');
  }

  deleteSelection(): void {
    if (this.selectedWireId) this.disconnect(this.selectedWireId);
    else if (this.selectedModuleId) this.removeModule(this.selectedModuleId);
  }

  // -- Notes (keyboard modules) ------------------------------------------

  /** key: stable identifier for the held note (e.g. "kbd:60" or "qwerty:a"). */
  noteOn(sourceModuleId: string, key: string, pitch: number, velocity = 0.9): void {
    void this.engine.start();
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
    void this.engine.start();
    if (cmd === 'play') this.transport.playing = true;
    if (cmd === 'pause') this.transport.playing = false;
    if (cmd === 'stop') {
      this.transport.playing = false;
      this.transport.songPosition = 0;
    }
    if (cmd === 'rewind') this.transport.songPosition = 0;
    this.emit('transportChanged');
  }

  setTempo(tempo: number): void {
    this.transport.tempo = Math.min(300, Math.max(20, tempo));
    for (const m of this.graph.modules.values()) {
      if (m.type === 'transport') m.params.tempo = this.transport.tempo;
    }
    this.emit('transportChanged');
    this.emit('paramChanged');
  }

  // -- Project -----------------------------------------------------------

  serialize(): string {
    return serializeProject(this.projectName, this.graph, this.transport);
  }

  loadProject(json: string): string[] {
    const result = deserializeProject(json, MODULE_DEFS);
    this.graph = result.graph;
    this.projectName = result.name;
    this.transport = result.transport;
    this.selectedModuleId = null;
    this.selectedWireId = null;
    this.heldVoices.clear();
    this.engine.syncGraph(this.graph);
    this.emit('projectLoaded');
    this.emit('graphChanged');
    this.emit('transportChanged');
    return result.warnings;
  }
}

export const appState = new AppState();
