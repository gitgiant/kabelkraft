/**
 * Core signal type system — PRD §4.
 * These definitions are normative and shared by the engine, the patch
 * JSON schema, and (later) the AI spec pack.
 */

export type PortType =
  | 'audio'
  | 'note'
  | 'control'
  | 'trigger'
  | 'transport'
  | 'color'
  | 'text'
  | 'visual';

export type PortDirection = 'in' | 'out';

/** Default wire/port colors per type — PRD §4 table. */
export const PORT_TYPE_COLORS: Record<PortType, number> = {
  audio: 0xffb13d, // amber
  note: 0x3dd9ff, // cyan
  control: 0xff3dd0, // magenta
  trigger: 0x52e07a, // green
  transport: 0xf0f0f0, // white
  color: 0xb070ff, // violet — carries a live RGB value (Color Gen → UI tints)
  text: 0xb9c0cc, // steel — carries live string events (lyrics, readouts)
  visual: 0x52e0c4, // teal — carries a rendered frame (visualizer chaining)
};

/** One text-stream event (text wires). Interim events stream while a final one is forming. */
export interface TextEvent {
  text: string;
  /** False while still forming (speech interim results — karaoke feel). */
  final: boolean;
}

/** Audio channel layout per wire — stereo by default (PRD §4.1). */
export type ChannelLayout = 'mono' | 'stereo';

// ---------------------------------------------------------------------------
// Note events (PRD §4.1) — polyphonic stream keyed by voiceId.
// ---------------------------------------------------------------------------

export interface NoteOnEvent {
  kind: 'noteOn';
  /** Float MIDI note number; fractional = microtonal. */
  pitch: number;
  /** 0.0–1.0 */
  velocity: number;
  /** Engine-assigned voice key; receivers track voices by id, never pitch. */
  voiceId: number;
  /** 1–16 */
  channel: number;
}

export interface NoteOffEvent {
  kind: 'noteOff';
  voiceId: number;
  /** 0.0–1.0 */
  releaseVelocity: number;
}

export interface PressureEvent {
  kind: 'pressure';
  voiceId: number;
  value: number;
}

export interface PitchBendEvent {
  kind: 'pitchBend';
  /** Omitted voiceId = channel-wide. */
  voiceId?: number;
  semitones: number;
}

export type NoteEvent = NoteOnEvent | NoteOffEvent | PressureEvent | PitchBendEvent;

// ---------------------------------------------------------------------------
// Trigger events (PRD §4.1)
// ---------------------------------------------------------------------------

export interface TriggerEvent {
  /** Sample-accurate timestamp (seconds in engine time). */
  time: number;
  /** 0.0–1.0, default 1.0. */
  strength: number;
}

// ---------------------------------------------------------------------------
// Transport (PRD §4.1)
// ---------------------------------------------------------------------------

export type TransportCommand = 'play' | 'stop' | 'pause' | 'rewind';

export interface TransportState {
  playing: boolean;
  /** BPM, default 120 (PRD §8.1). */
  tempo: number;
  timeSignature: { num: number; denom: number };
  /** Beats, float. */
  songPosition: number;
}

export const DEFAULT_TRANSPORT: TransportState = {
  playing: false,
  tempo: 120,
  timeSignature: { num: 4, denom: 4 },
  songPosition: 0,
};

// ---------------------------------------------------------------------------
// Control metadata (PRD §4.1) — semantic hints, never connection restrictions.
// ---------------------------------------------------------------------------

export type ControlCurve = 'linear' | 'log' | 'exp';

export interface ControlMeta {
  unit?: 'Hz' | 'dB' | 'semitones' | '%' | 'ms' | 's';
  min?: number;
  max?: number;
  curve?: ControlCurve;
}
