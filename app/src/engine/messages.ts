/**
 * Main-thread ↔ AudioWorklet message protocol.
 * This boundary is deliberately thin and serializable — it is the same seam
 * the C++/WASM core slots into in Phase 2 (PRD §16).
 */

export type EngineModuleType = 'synth' | 'audioOut' | 'levels' | 'sequencer' | 'lfo';

export interface EngineModuleSnapshot {
  id: string;
  type: EngineModuleType;
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

export interface EngineWireSnapshot {
  type: 'audio' | 'note' | 'control';
  fromModuleId: string;
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

export type EngineMessage =
  | GraphMessage
  | ParamMessage
  | DataMessage
  | TransportMessage
  | NoteOnMessage
  | NoteOffMessage;

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
  /** Module ids that emitted notes since the last post (for wire flashes). */
  noteActivity: string[];
  /** Transport position in beats (worklet is the clock while playing). */
  songPosition: number;
}
