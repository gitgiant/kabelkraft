/**
 * Main-thread ↔ AudioWorklet message protocol.
 * This boundary is deliberately thin and serializable — it is the same seam
 * the C++/WASM core slots into in Phase 2 (PRD §16).
 */

export type EngineModuleType =
  | 'synth'
  | 'sampler'
  | 'drum'
  | 'audioOut'
  | 'levels'
  | 'sequencer'
  | 'arp'
  | 'composer'
  | 'lfo'
  | 'adsr'
  | 'random'
  | 'delay'
  | 'reverb'
  | 'distortion'
  | 'eq'
  | 'chorus'
  | 'flanger'
  | 'bitcrusher'
  | 'compressor'
  | 'peq'
  | 'mbcomp'
  | 'midiIn'
  | 'midiOut'
  | 'visualizer'
  | 'limiter'
  | 'modulator'
  | 'mixer'
  | 'recorder';

export interface EngineModuleSnapshot {
  id: string;
  type: EngineModuleType;
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

export interface EngineWireSnapshot {
  type: 'audio' | 'note' | 'control';
  fromModuleId: string;
  /** Sending port — matters for multi-out note sources (composer tracks). */
  fromPortId: string;
  toModuleId: string;
  /** Receiving port — matters for control wires (which input gets modulated). */
  toPortId: string;
}

/** Full audio-relevant graph snapshot; sent on any structural change. */
export interface GraphMessage {
  type: 'graph';
  modules: EngineModuleSnapshot[];
  wires: EngineWireSnapshot[];
}

export interface ParamMessage {
  type: 'param';
  moduleId: string;
  paramId: string;
  value: number;
}

/** Replace one key of a module's data blob (e.g. sequencer steps). */
export interface DataMessage {
  type: 'data';
  moduleId: string;
  key: string;
  value: unknown;
}

export interface TransportMessage {
  type: 'transport';
  playing: boolean;
  tempo: number;
  /** Set to jump (stop/rewind); omit to leave the worklet's position alone. */
  songPosition?: number;
}

export interface NoteOnMessage {
  type: 'noteOn';
  moduleId: string;
  pitch: number;
  velocity: number;
  voiceId: number;
}

export interface NoteOffMessage {
  type: 'noteOff';
  moduleId: string;
  voiceId: number;
}

/** Deliver sample PCM to a sampler module or drum pad (channel buffers are copies). */
export interface SampleMessage {
  type: 'sample';
  moduleId: string;
  /** Drum machine pad index; absent for the sampler. */
  pad?: number;
  sampleRate: number;
  channels: Float32Array[];
  /** Loop region in frames; absent = loop the whole sample. */
  loopStart?: number;
  loopEnd?: number;
}

export interface RecordControlMessage {
  type: 'recordStart' | 'recordStop';
  moduleId: string;
}

/** Set a control-source module's live output (MIDI In CC → control wires). */
export interface ControlMessage {
  type: 'control';
  moduleId: string;
  /** 0–1 */
  value: number;
}

export type EngineMessage =
  | GraphMessage
  | ParamMessage
  | DataMessage
  | TransportMessage
  | NoteOnMessage
  | NoteOffMessage
  | SampleMessage
  | RecordControlMessage
  | ControlMessage;

/** Worklet → main thread, ~30 Hz. */
export interface MeterReading {
  peak: number;
  rms: number;
  clipped: boolean;
}

export interface StatusMessage {
  type: 'status';
  meters: Record<string, MeterReading>;
  /** Current step per sequencer module (for playhead UI). */
  seqSteps: Record<string, number>;
  /** Live control output values (0–1) per control-source module. */
  controlValues: Record<string, number>;
  /** Live gain reduction in dB per compressor/limiter module. */
  gainReduction: Record<string, number>;
  /** Live input spectrum per parametric EQ: 64 log-spaced bins, dB. */
  spectra: Record<string, number[]>;
  /** Visualizer feeds: waveform (256 pts), spectrum (64 bins dB), note pitches, control. */
  visData: Record<string, { wave: number[]; spectrum: number[]; notes: number[]; ctrl: number }>;
  /** Module ids that emitted notes since the last post (for wire flashes). */
  noteActivity: string[];
  /** Transport position in beats (worklet is the clock while playing). */
  songPosition: number;
}

/** Worklet → main: a chunk of captured audio from a recorder module. */
export interface RecordDataMessage {
  type: 'recordData';
  moduleId: string;
  sampleRate: number;
  chL: Float32Array;
  chR: Float32Array;
}

/** Worklet → main: MIDI events that reached a MIDI Out module this block. */
export interface MidiEventsMessage {
  type: 'midi';
  events: Array<{
    moduleId: string;
    kind: 'on' | 'off' | 'cc';
    pitch?: number;
    velocity?: number;
    value?: number;
  }>;
}

export type WorkletMessage = StatusMessage | RecordDataMessage | MidiEventsMessage;
