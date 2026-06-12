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
  MidiEventsMessage,
  RecordDataMessage,
  StatusMessage,
  WorkletMessage,
} from './messages';

const ENGINE_MODULE_TYPES = new Set<EngineModuleType>([
  'synth',
  'sampler',
  'drum',
  'audioOut',
  'levels',
  'sequencer',
  'arp',
  'composer',
  'notethru',
  'lfo',
  'delay',
  'reverb',
  'distortion',
  'chorus',
  'flanger',
  'bitcrusher',
  'compressor',
  'peq',
  'mbcomp',
  'midiIn',
  'midiOut',
  'visualizer',
  'limiter',
  'modulator',
  'adsr',
  'random',
  'eq',
  'mixer',
  'recorder',
  'voice',
  'osc',
  'wtosc',
  'smpl',
  'vcf',
  'vca',
  'knob',
  'slider',
  'xy',
  'button',
  'quantizer',
  'sah',
  'slew',
  'cmath',
  'modmatrix',
  'notenames',
]);

export type StatusListener = (status: StatusMessage) => void;
export type RecordDataListener = (data: RecordDataMessage) => void;
export type MidiEventsListener = (msg: MidiEventsMessage) => void;

export class Engine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private statusListeners = new Set<StatusListener>();
  private recordListeners = new Set<RecordDataListener>();
  private midiListeners = new Set<MidiEventsListener>();
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
    if (!this.ctx.audioWorklet) {
      throw new Error(
        'AudioWorklet unavailable — page must be served over HTTPS or localhost (secure context).',
      );
    }
    await this.ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}engine-worklet.js`);
    this.node = new AudioWorkletNode(this.ctx, 'kabelkraft-engine', {
      numberOfInputs: 0,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
      if (e.data.type === 'status') {
        for (const l of this.statusListeners) l(e.data);
      } else if (e.data.type === 'recordData') {
        for (const l of this.recordListeners) l(e.data);
      } else if (e.data.type === 'midi') {
        for (const l of this.midiListeners) l(e.data);
      }
    };
    this.node.connect(this.ctx.destination);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onRecordData(listener: RecordDataListener): () => void {
    this.recordListeners.add(listener);
    return () => this.recordListeners.delete(listener);
  }

  onMidiEvents(listener: MidiEventsListener): () => void {
    this.midiListeners.add(listener);
    return () => this.midiListeners.delete(listener);
  }

  /** Drive a MIDI In module's control output (CC value 0–1). */
  sendControl(moduleId: string, value: number): void {
    this.send({ type: 'control', moduleId, value });
  }

  recordStart(moduleId: string): void {
    this.send({ type: 'recordStart', moduleId });
  }

  recordStop(moduleId: string): void {
    this.send({ type: 'recordStop', moduleId });
  }

  /** Hard silence: kill voices + zero all audio buffers (cuts feedback loops). */
  panic(): void {
    this.send({ type: 'panic' });
  }

  /** SAB audio rings per visualizer module (visual engine feeds). */
  private visRings = new Map<string, SharedArrayBuffer>();

  /**
   * Register a visualizer's SAB ring. Re-sent with every graph sync so rings
   * survive worklet (re)starts and arrive after the module exists.
   */
  attachVisRing(moduleId: string, sab: SharedArrayBuffer): void {
    this.visRings.set(moduleId, sab);
    this.send({ type: 'visRing', moduleId, sab });
  }

  detachVisRing(moduleId: string): void {
    this.visRings.delete(moduleId);
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
        fromPortId: w.from.portId,
        toModuleId: w.to.moduleId,
        toPortId: w.to.portId,
      });
    }
    this.send({ type: 'graph', modules, wires });
    for (const [moduleId, sab] of this.visRings) {
      if (engineIds.has(moduleId)) this.send({ type: 'visRing', moduleId, sab });
      else this.visRings.delete(moduleId);
    }
  }

  setParam(moduleId: string, paramId: string, value: number): void {
    this.send({ type: 'param', moduleId, paramId, value });
  }

  setData(moduleId: string, key: string, value: unknown): void {
    this.send({ type: 'data', moduleId, key, value });
  }

  /** Engine sample rate; display math (EQ curves) uses this. */
  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  /** Decode an audio file using the engine's AudioContext. */
  async decode(buffer: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.ctx) throw new Error('Engine not started');
    return this.ctx.decodeAudioData(buffer);
  }

  sendSample(
    moduleId: string,
    sample: { sampleRate: number; channels: Float32Array[]; loopStart?: number; loopEnd?: number },
    pad?: number,
  ): void {
    // Copies, so the main-thread store keeps its data (waveform UI, saving).
    const copies = sample.channels.map((c) => c.slice());
    this.node?.port.postMessage(
      {
        type: 'sample',
        moduleId,
        pad,
        sampleRate: sample.sampleRate,
        channels: copies,
        loopStart: sample.loopStart,
        loopEnd: sample.loopEnd,
      },
      copies.map((c) => c.buffer),
    );
  }

  /** Audition PCM outside the graph (Sample Editor preview). */
  preview(sampleRate: number, channels: Float32Array[]): void {
    if (!this.ctx) return;
    this.stopPreview();
    const buf = this.ctx.createBuffer(channels.length, channels[0].length, sampleRate);
    channels.forEach((c, i) => buf.copyToChannel(new Float32Array(c), i));
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.onended = () => {
      if (this.previewSource === src) this.previewSource = null;
    };
    src.start();
    this.previewSource = src;
  }

  stopPreview(): void {
    this.previewSource?.stop();
    this.previewSource = null;
  }

  private previewSource: AudioBufferSourceNode | null = null;

  sendTransport(t: TransportState, jumpTo?: number): void {
    this.send({ type: 'transport', playing: t.playing, tempo: t.tempo, songPosition: jumpTo });
  }

  allocVoiceId(): number {
    return this.nextVoiceId++;
  }

  /** Direct note to one module, no wire routing (drum pad audition). */
  noteOnModule(moduleId: string, voiceId: number, pitch: number, velocity: number): void {
    this.send({ type: 'noteOn', moduleId, pitch, velocity, voiceId });
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
