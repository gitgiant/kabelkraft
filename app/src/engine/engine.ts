/**
 * Main-thread engine controller: owns the AudioContext and the worklet,
 * mirrors the audio-relevant graph into it, and routes note events along
 * note wires (note routing is resolved on the main thread in Phase 0).
 */

import type { Graph } from '../core/graph';
import type {
  EngineMessage,
  EngineModuleSnapshot,
  EngineWireSnapshot,
  MeterReading,
  MetersMessage,
} from './messages';

const AUDIO_MODULE_TYPES = new Set(['synth', 'audioOut', 'levels']);

export type MeterListener = (meters: Record<string, MeterReading>) => void;

export class Engine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private meterListeners = new Set<MeterListener>();
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
    this.node.port.onmessage = (e: MessageEvent<MetersMessage>) => {
      if (e.data.type === 'meters') {
        for (const l of this.meterListeners) l(e.data.meters);
      }
    };
    this.node.connect(this.ctx.destination);
  }

  onMeters(listener: MeterListener): () => void {
    this.meterListeners.add(listener);
    return () => this.meterListeners.delete(listener);
  }

  private send(msg: EngineMessage): void {
    this.node?.port.postMessage(msg);
  }

  /** Push the audio-relevant subset of the graph; call on structural change. */
  syncGraph(graph: Graph): void {
    const modules: EngineModuleSnapshot[] = [];
    for (const m of graph.modules.values()) {
      if (AUDIO_MODULE_TYPES.has(m.type)) {
        modules.push({
          id: m.id,
          type: m.type as EngineModuleSnapshot['type'],
          params: { ...m.params },
        });
      }
    }
    const wires: EngineWireSnapshot[] = [];
    for (const w of graph.wires.values()) {
      if (w.type === 'audio') {
        wires.push({ fromModuleId: w.from.moduleId, toModuleId: w.to.moduleId });
      }
    }
    this.send({ type: 'graph', modules, wires });
  }

  setParam(moduleId: string, paramId: string, value: number): void {
    this.send({ type: 'param', moduleId, paramId, value });
  }

  allocVoiceId(): number {
    return this.nextVoiceId++;
  }

  /**
   * Send a note event from a source module's note output, fanned out along
   * note wires to every connected receiver.
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
