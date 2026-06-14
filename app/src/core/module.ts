/**
 * Module definitions and instances — PRD §3, §7.
 * A ModuleDef describes a module type (ports, params, face); a ModuleInstance
 * is one placed on the canvas with its own state.
 */

import type { ControlCurve, PortDirection, PortType } from './types';

export interface PortSpec {
  id: string;
  label: string;
  type: PortType;
  direction: PortDirection;
  /** Tooltip text — PRD §5 hover requirement. */
  description: string;
}

export interface ParamSpec {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  curve?: ControlCurve;
  unit?: string;
  /** Discrete value labels (e.g. waveform names); param then holds an index. */
  options?: string[];
  /**
   * Mode-scoped param (synth): only shown when the module's `mode` param
   * matches. Always serialized and sent to the engine regardless.
   */
  group?: string;
  /**
   * Excluded from Randomize (PRD §7): output gain/levels and anything
   * hearing-hazardous must set this.
   */
  randomizable?: boolean;
}

export interface ModuleDef {
  /** Stable type id used in patch JSON, e.g. "synth". */
  type: string;
  name: string;
  category: 'generator' | 'component' | 'data' | 'effect' | 'visual' | 'controller' | 'io' | 'misc';
  description: string;
  ports: PortSpec[];
  params: ParamSpec[];
  /** Default tile size on canvas (world units). */
  width: number;
  height: number;
  /** Params render in two columns (many-param modules). */
  twoColumn?: boolean;
  /** Suppress auto param rows entirely — the module draws its own face (e.g. EQ curve). */
  customFace?: boolean;
  /** Initial non-scalar state (e.g. sequencer steps); serialized with the patch. */
  defaultData?: () => Record<string, unknown>;
}

/** One internal wire captured in a container preset (both endpoints inside). */
export interface PresetWire {
  from: { moduleId: string; portId: string };
  to: { moduleId: string; portId: string };
}

/**
 * A saved configuration snapshot — PRESETS_PLAN.md. Plain modules store their
 * own `params`/`data`; containers (groups) store every member's params/data
 * (`members`) plus the internal `wires`. The member set is frozen — a preset
 * never adds/removes modules, only retunes and rewires existing ones.
 */
export interface ModulePreset {
  id: string;
  name: string;
  /** Free-text grouping (e.g. bass/lead/pad); "Default" when unset. */
  category: string;
  // Plain-module shape:
  params?: Record<string, number>;
  data?: Record<string, unknown>;
  // Container shape:
  members?: Record<string, { params: Record<string, number>; data?: Record<string, unknown> }>;
  /** Internal wires only (both endpoints among the members). */
  wires?: PresetWire[];
}

export interface ModuleInstance {
  id: string;
  type: string;
  x: number;
  y: number;
  /** User-resized tile size (world units); undefined = the def's default. */
  w?: number;
  h?: number;
  label?: string;
  /** User tint color (PRD §6) as 24-bit RGB, undefined = theme default. */
  color?: number;
  params: Record<string, number>;
  /** Non-scalar module state (e.g. sequencer steps). */
  data?: Record<string, unknown>;
  /** Saved configuration snapshots (PRESETS_PLAN.md); lazily created. */
  presets?: ModulePreset[];
  /** Last-loaded preset id; dirty = live state differs from this snapshot. */
  activePresetId?: string;
}

let nextId = 1;

export function newModuleId(): string {
  return `m${nextId++}`;
}

/** For deserialization: keep generated ids ahead of loaded ones. */
export function bumpModuleId(existing: string): void {
  const n = Number(existing.replace(/^m/, ''));
  if (Number.isFinite(n) && n >= nextId) nextId = n + 1;
}

export function createInstance(def: ModuleDef, x: number, y: number): ModuleInstance {
  const params: Record<string, number> = {};
  for (const p of def.params) params[p.id] = p.default;
  return { id: newModuleId(), type: def.type, x, y, params, data: def.defaultData?.() };
}
