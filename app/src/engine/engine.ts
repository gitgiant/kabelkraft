/**
 * Main-thread engine controller: owns the AudioContext and the worklet,
 * mirrors the audio-relevant graph into it, and routes UI-generated note
 * events (keyboard modules) along note wires. Engine-generated events
 * (sequencer notes, LFO control) are routed inside the worklet, where
 * timing is sample-accurate.
 */

import type { Graph } from '../core/graph';
import type { TransportState } from '../core/types';
import { ENGINE_MODULE_TYPES } from '../core/registry';
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

export type StatusListener = (status: StatusMessage) => void;
export type RecordDataListener = (data: RecordDataMessage) => void;
export type MidiEventsListener = (msg: MidiEventsMessage) => void;

/** Construction-time audio options (Options → Audio); changes need a restart. */
export interface EngineAudioOptions {
  latencyHint: 'interactive' | 'balanced' | 'playback';
  /** Requested context rate; 0 = browser default. */
  sampleRate: number;
  /** Output device id; '' = system default. Chrome/Edge only. */
  sinkId: string;
}

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/**
 * Live-input capacity: the worklet node is built with this many inputs,
 * each fed by one capture device (all of its channels). Distinct Audio In
 * devices beyond this share the last slot.
 */
export const INPUT_SLOTS = 4;

/** Hardware output channel ceiling (4 pairs — covers typical interfaces). */
export const MAX_OUTPUT_CHANNELS = 8;
/** Capture channel ceiling requested from getUserMedia. */
export const MAX_INPUT_CHANNELS = 8;

interface InputStream {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  slot: number;
  /** Channels the browser actually delivered for this device. */
  channels: number;
}

export class Engine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  private statusListeners = new Set<StatusListener>();
  private recordListeners = new Set<RecordDataListener>();
  private midiListeners = new Set<MidiEventsListener>();
  private nextVoiceId = 1;

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Context exists (it may be suspended) — restart only makes sense then. */
  get started(): boolean {
    return this.ctx !== null;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  async start(opts?: EngineAudioOptions): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const baseOpts: AudioContextOptions = {
      latencyHint: opts?.latencyHint ?? 'interactive',
      ...(opts?.sampleRate ? { sampleRate: opts.sampleRate } : {}),
    };
    try {
      // Constructor-time sink (Chrome 110+) so maxChannelCount reflects the
      // chosen interface, not the system default device.
      this.ctx = new AudioContext({
        ...baseOpts,
        ...(opts?.sinkId ? { sinkId: opts.sinkId } : {}),
      } as AudioContextOptions);
    } catch (err) {
      // A persisted output device that's gone (unplugged interface, other
      // machine) must never brick audio — fall back to the system default.
      if (!opts?.sinkId) throw err;
      this.ctx = new AudioContext(baseOpts);
    }
    if (!this.ctx.audioWorklet) {
      throw new Error(
        'AudioWorklet unavailable — page must be served over HTTPS or localhost (secure context).',
      );
    }
    if (opts?.sinkId) await this.setSinkId(opts.sinkId); // fallback for non-constructor browsers
    // Multichannel interfaces (MiniFuse 4 etc.): open every hardware output,
    // discrete so channels 3+ aren't folded into a stereo downmix. Audio Out
    // modules pick their pair (1-2 / 3-4 / …) via the `pair` param.
    this.outCh = Math.max(2, Math.min(this.ctx.destination.maxChannelCount || 2, MAX_OUTPUT_CHANNELS));
    if (this.outCh > 2) {
      try {
        this.ctx.destination.channelCount = this.outCh;
        this.ctx.destination.channelInterpretation = 'discrete';
      } catch {
        this.outCh = 2; // device rejected the count — stereo it is
      }
    }
    await this.ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}engine-worklet.js`);
    this.node = new AudioWorkletNode(this.ctx, 'kabelkraft-engine', {
      numberOfInputs: INPUT_SLOTS,
      outputChannelCount: [this.outCh],
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
    this.master = this.ctx.createGain();
    if (this.outCh > 2) {
      // Explicit + discrete so the gain stage carries all hardware channels
      // through untouched instead of mixing down to its default stereo.
      this.master.channelCount = this.outCh;
      this.master.channelCountMode = 'explicit';
      this.master.channelInterpretation = 'discrete';
    }
    this.node.connect(this.master);
    this.master.connect(this.ctx.destination);
  }

  /** Tear the context down so the next start() rebuilds with fresh options. */
  async stop(): Promise<void> {
    this.stopPreview();
    this.metroStopScheduler();
    this.closeAllInputs();
    this.node?.disconnect();
    this.node = null;
    this.master = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => undefined);
  }

  /** Master output level (Options → Audio); 0 while muted. */
  setMasterGain(gain: number): void {
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
    }
  }

  /** Route output to a specific device; no-op where setSinkId is unsupported. */
  async setSinkId(id: string): Promise<void> {
    const ctx = this.ctx as SinkContext | null;
    if (ctx?.setSinkId) await ctx.setSinkId(id).catch(() => undefined);
  }

  /** Whether this browser supports output device selection. */
  static get sinkSelectable(): boolean {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  }

  // -- Live inputs (Audio In modules) ----------------------------------------

  /** Hardware output channels the context opened with (≥2). */
  private outCh = 2;

  /** Channels the current output device is running (Options read-out, pair UI). */
  get outputChannels(): number {
    return this.outCh;
  }

  /** Per-device capture info for open streams (Options read-out, pair UI). */
  inputChannelInfo(): Array<{ deviceId: string; channels: number }> {
    return [...this.inputStreams.entries()].map(([deviceId, s]) => ({
      deviceId,
      channels: s.channels,
    }));
  }

  /** Options → Audio default capture device, used by Audio In modules set to ''. */
  defaultInputId = '';
  /** Open capture streams keyed by deviceId; each owns one worklet input slot. */
  private inputStreams = new Map<string, InputStream>();
  private inputSync = Promise.resolve();
  /** Last capture failure per deviceId ('' = default), for UI surfacing. */
  inputErrors = new Map<string, string>();

  /**
   * Reconcile capture streams with the Audio In modules in the graph: open a
   * stream per distinct device, connect each to its own worklet input slot,
   * close streams no module wants anymore, and tell each module (via its
   * data blob) which slot to read. Serialised so rapid graph edits cannot
   * interleave getUserMedia calls.
   */
  syncInputs(graph: Graph): void {
    const wanted = new Map<string, string[]>(); // deviceId → moduleIds
    for (const m of graph.modules.values()) {
      if (m.type !== 'audioIn') continue;
      const dev = (m.data?.deviceId as string) || this.defaultInputId;
      const list = wanted.get(dev);
      if (list) list.push(m.id);
      else wanted.set(dev, [m.id]);
    }
    this.inputSync = this.inputSync.then(() => this.applyInputs(wanted)).catch(() => undefined);
  }

  private async applyInputs(wanted: Map<string, string[]>): Promise<void> {
    if (!this.ctx || !this.node) {
      if (wanted.size === 0) this.closeAllInputs();
      return;
    }
    // Close streams nothing references (frees the device + its slot).
    for (const [dev, s] of this.inputStreams) {
      if (!wanted.has(dev)) {
        s.source.disconnect();
        for (const t of s.stream.getTracks()) t.stop();
        this.inputStreams.delete(dev);
      }
    }
    for (const [dev, moduleIds] of wanted) {
      let entry = this.inputStreams.get(dev);
      if (!entry) {
        const slots = new Set([...this.inputStreams.values()].map((s) => s.slot));
        let slot = 0;
        while (slots.has(slot) && slot < INPUT_SLOTS - 1) slot++;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              ...(dev ? { deviceId: { exact: dev } } : {}),
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              // Ask for everything the interface has; the browser clamps to
              // what the driver supports (stereo on most built-in mics).
              channelCount: { ideal: MAX_INPUT_CHANNELS },
            },
          });
          const track = stream.getAudioTracks()[0];
          let channels = track?.getSettings().channelCount ?? 2;
          // Some drivers open at fewer channels than they advertise — bump to
          // the track's stated capability when there's more to be had.
          const capMax = track?.getCapabilities?.().channelCount?.max ?? channels;
          if (capMax > channels) {
            await track
              .applyConstraints({ channelCount: { exact: Math.min(capMax, MAX_INPUT_CHANNELS) } })
              .then(() => {
                channels = track.getSettings().channelCount ?? channels;
              })
              .catch(() => undefined);
          }
          if (!this.ctx || !this.node) {
            for (const t of stream.getTracks()) t.stop();
            return;
          }
          const source = this.ctx.createMediaStreamSource(stream);
          source.connect(this.node, 0, slot);
          entry = { stream, source, slot, channels };
          this.inputStreams.set(dev, entry);
          this.inputErrors.delete(dev);
        } catch (err) {
          this.inputErrors.set(dev, err instanceof Error ? err.message : 'capture failed');
          continue;
        }
      }
      for (const id of moduleIds) this.setData(id, 'slot', entry.slot);
    }
  }

  private closeAllInputs(): void {
    for (const s of this.inputStreams.values()) {
      s.source.disconnect();
      for (const t of s.stream.getTracks()) t.stop();
    }
    this.inputStreams.clear();
  }

  /** Measured latencies for the Options/Debug read-outs. */
  latencyInfo(): { base: number; output: number } | null {
    if (!this.ctx) return null;
    return { base: this.ctx.baseLatency ?? 0, output: this.ctx.outputLatency ?? 0 };
  }

  get contextState(): string {
    return this.ctx?.state ?? 'none';
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
    this.syncInputs(graph);
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
    src.connect(this.master ?? this.ctx.destination);
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

  // -- Monitor metronome (Options → Recording) ------------------------------
  // A main-thread lookahead scheduler → ctx.destination, parallel to the
  // master bus, so the click is heard while tracking but never reaches the
  // recorder (which taps the worklet mix). Play-gated: clicks only while the
  // transport is playing, locked to song position for downbeat accents.
  private metroEnabled = false;
  private metroVolume = 0.5;
  private metroTimer: ReturnType<typeof setInterval> | null = null;
  private metroTempo = 120;
  private metroMeter = 4;
  private metroPlaying = false;
  private metroPhaseBeats = 0;
  private metroNextTime = 0;
  private metroBeat = 0;

  /** Arm/disarm the monitor metronome and set its click level (0–1). */
  setMetronome(enabled: boolean, volume: number): void {
    this.metroEnabled = enabled;
    this.metroVolume = volume;
    this.updateMetro();
  }

  private updateMetro(): void {
    if (this.metroEnabled && this.metroPlaying && this.running) this.metroStartScheduler();
    else this.metroStopScheduler();
  }

  private metroStartScheduler(): void {
    if (this.metroTimer || !this.ctx) return;
    this.metroBeat = Math.max(0, Math.round(this.metroPhaseBeats));
    this.metroNextTime = this.ctx.currentTime + 0.06;
    this.metroTick();
    this.metroTimer = setInterval(() => this.metroTick(), 25);
  }

  private metroStopScheduler(): void {
    if (this.metroTimer) {
      clearInterval(this.metroTimer);
      this.metroTimer = null;
    }
  }

  private metroTick(): void {
    if (!this.ctx) return;
    const lookahead = 0.1; // schedule clicks 100 ms ahead of the clock
    while (this.metroNextTime < this.ctx.currentTime + lookahead) {
      this.scheduleClick(this.metroNextTime, this.metroBeat % this.metroMeter === 0);
      this.metroNextTime += 60 / this.metroTempo;
      this.metroBeat++;
    }
  }

  private scheduleClick(when: number, accent: boolean): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1000;
    const peak = this.metroVolume * (accent ? 1 : 0.7);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(when);
    osc.stop(when + 0.06);
  }

  sendTransport(t: TransportState, jumpTo?: number): void {
    this.send({ type: 'transport', playing: t.playing, tempo: t.tempo, songPosition: jumpTo });
    this.metroTempo = t.tempo;
    this.metroPlaying = t.playing;
    this.metroMeter = Math.max(1, t.timeSignature?.num ?? 4);
    if (jumpTo !== undefined) this.metroPhaseBeats = jumpTo;
    this.updateMetro();
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
