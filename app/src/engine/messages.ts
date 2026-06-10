/**
 * Main-thread ↔ AudioWorklet message protocol.
 * This boundary is deliberately thin and serializable — it is the same seam
 * the C++/WASM core slots into in Phase 2 (PRD §16).
 */

export interface EngineModuleSnapshot {
  id: string;
  type: 'synth' | 'audioOut' | 'levels';
  params: Record<string, number>;
}

export interface EngineWireSnapshot {
  fromModuleId: string;
  toModuleId: string;
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

export type EngineMessage = GraphMessage | ParamMessage | NoteOnMessage | NoteOffMessage;

/** Worklet → main thread: per-module output meters at ~30 Hz. */
export interface MeterReading {
  peak: number;
  rms: number;
  clipped: boolean;
}

export interface MetersMessage {
  type: 'meters';
  meters: Record<string, MeterReading>;
}
