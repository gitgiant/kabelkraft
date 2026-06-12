/**
 * Visual engine type system — VISUALIZER_ENGINE_PLAN.md.
 * A visualizer module is a container holding a nested visual graph (a DAG of
 * visual nodes). These types are pure data: they are serialized inside the
 * module's `data.graph` payload, validated by the AI import path, and consumed
 * by the WebGPU runtime. Nothing in this file may touch the GPU or the DOM so
 * core code (registry defaults, serialization migration) can import it freely.
 */

/** Port types inside the visual graph. `visual` = GPU texture stream. */
export type VisPortType = 'visual' | 'control' | 'note' | 'text';

export interface VisPortSpec {
  id: string;
  label: string;
  type: VisPortType;
  direction: 'in' | 'out';
  description: string;
}

export interface VisParamSpec {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  /** Discrete value labels; param holds an index. */
  options?: string[];
  unit?: string;
  /**
   * How a wired same-id control in-port modulates the param. `multiply`
   * (default) scales the knob value by the 0–1 control; `add-wrap` adds the
   * control and wraps into 0–1 — for circular params (hue, angle). Either way
   * the result clamps to [min, max].
   */
  modMode?: 'multiply' | 'add-wrap';
}

export type VisNodeCategory = 'source' | 'effect' | 'combine' | 'util';

/** Describes a visual node type — mirrors ModuleDef so palette/inspector/AI-spec code can share shape. */
export interface VisNodeDef {
  /** Stable type id used in the graph JSON, e.g. "spectrum". */
  type: string;
  name: string;
  category: VisNodeCategory;
  description: string;
  ports: VisPortSpec[];
  params: VisParamSpec[];
}

export interface VisNodeInstance {
  id: string;
  type: string;
  /** Position on the container's sub-canvas (world units). */
  x: number;
  y: number;
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

export interface VisWire {
  id: string;
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
}

/** The container's nested graph — stored as `module.data.graph`. */
export interface VisGraphData {
  nodes: VisNodeInstance[];
  wires: VisWire[];
}

/**
 * Per-frame audio analysis shared by every node in a container.
 * Raw windows stay in the pack so future nodes can derive anything
 * (lissajous, chromagram, custom-resolution FFT) without engine changes.
 */
export interface VisFeatures {
  /** Mono window, (L+R)/2, newest sample last. */
  wave: Float32Array;
  waveL: Float32Array;
  waveR: Float32Array;
  /** 64 log-spaced (20 Hz – 20 kHz) magnitude bins, dB (≈ −80..0). */
  spectrum: Float32Array;
  /** Window RMS, 0..~1. */
  level: number;
  /** Window peak |sample|. */
  peak: number;
  /** Normalized 0..1 band energies. */
  bands: { bass: number; mid: number; high: number };
  /** Onset strength since last frame, 0 = none. */
  onset: number;
  /** Spectral centroid, normalized 0..1 across the log-bin range. */
  centroid: number;
  /** Recent note pitches (drained per frame). */
  notes: number[];
  /** Mod-input control value, −1 when unwired. */
  ctrl: number;
  /** Live text line from the container's text pole ('' = none). Interim lines update in place. */
  text: string;
  /** Recent finalized lines, newest last (karaoke stack), capped. */
  textStack: string[];
}

/** Analysis window length in samples (raw windows + FFT size). */
export const VIS_WINDOW = 1024;

export interface VisGraphCounts {
  nodes: number;
  wires: number;
}
