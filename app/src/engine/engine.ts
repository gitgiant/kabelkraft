/**
 * Main-thread engine controller: owns the AudioContext and the worklet,
 * mirrors the audio-relevant graph into it, and routes UI-generated note
 * events (keyboard modules) along note wires. Engine-generated events
 * (sequencer notes, LFO control) are routed inside the worklet, where
 * timing is sample-accurate.
 */

import type { Graph } from '../core/graph';
import type { TransportState } from '../core/types';
import type {
  EngineMessage,
  EngineModuleSnapshot,
  EngineModuleType,
  EngineWireSnapshot,
  StatusMessage,
} from './messages';

const ENGINE_MODULE_TYPES = new Set<EngineModuleType>([
  'synth',
  'audioOut',
  'levels',
  'sequencer',
  'lfo',
]);

export type StatusListener = (status: StatusMessage) => void;

export class Engine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private statusListeners = new Set<StatusListener>();
  private nextVoiceId = 1;

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  async start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('/engine-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'kabelkraft-engine', {
      numberOfInputs: 0,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (e: MessageEvent<StatusMessage>) => {
      if (e.data.type === 'status') {
        for (const l of this.statusListeners) l(e.data);
      }
    };
    this.node.connect(this.ctx.destination);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private send(msg: EngineMessage): void {
    this.node?.port.postMessage(msg);
  }

  /** Push the audio-relevant subset of the graph; call on structural change. */
  syncGraph(graph: Graph): void {
    const modules: EngineModuleSnapshot[] = [];
    for (const m of graph.modules.values()) {
      if (ENGINE_MODULE_TYPES.has(m.type as EngineModuleType)) {
        modules.push({
          id: m.id,
          type: m.type as EngineModuleType,
          params: { ...m.params },
          data: m.data,
        });
      }
    }
    const engineIds = new Set(modules.map((m) => m.id));
    const wires: EngineWireSnapshot[] = [];
    for (const w of graph.wires.values()) {
      if (w.type !== 'audio' && w.type !== 'note' && w.type !== 'control') continue;
      // Only wires the worklet routes itself: both ends engine-side.
      if (!engineIds.has(w.from.moduleId) || !engineIds.has(w.to.moduleId)) continue;
      wires.push({
        type: w.type,
        fromModuleId: w.from.moduleId,
        toModuleId: w.to.moduleId,
        toPortId: w.to.portId,
      });
    }
    this.send({ type: 'graph', modules, wires });
  }

  setParam(moduleId: string, paramId: string, value: number): void {
    this.send({ type: 'param', moduleId, paramId, value });
  }

  setData(moduleId: string, key: string, value: unknown): void {
    this.send({ type: 'data', moduleId, key, value });
  }

  sendTransport(t: TransportState, jumpTo?: number): void {
    this.send({ type: 'transport', playing: t.playing, tempo: t.tempo, songPosition: jumpTo });
  }

  allocVoiceId(): number {
    return this.nextVoiceId++;
  }

  /**
   * Send a note event from a UI-side source module's note output, fanned out
   * along note wires to every connected receiver.
   */
  noteOn(graph: Graph, sourceModuleId: string, voiceId: number, pitch: number, velocity: number): void {
    for (const target of this.noteTargets(graph, sourceModuleId)) {
      this.send({ type: 'noteOn', moduleId: target, pitch, velocity, voiceId });
    }
  }

  noteOff(graph: Graph, sourceModuleId: string, voiceId: number): void {
    for (const target of this.noteTargets(graph, sourceModuleId)) {
      this.send({ type: 'noteOff', moduleId: target, voiceId });
    }
  }

  private noteTargets(graph: Graph, sourceModuleId: string): string[] {
    const targets: string[] = [];
    for (const w of graph.wires.values()) {
      if (w.type === 'note' && w.from.moduleId === sourceModuleId) {
        targets.push(w.to.moduleId);
      }
    }
    return targets;
  }
}
