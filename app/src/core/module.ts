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
   * Excluded from Randomize (PRD §7): output gain/levels and anything
   * hearing-hazardous must set this.
   */
  randomizable?: boolean;
}

export interface ModuleDef {
  /** Stable type id used in patch JSON, e.g. "synth". */
  type: string;
  name: string;
  category: 'generator' | 'data' | 'effect' | 'visual' | 'controller' | 'io' | 'misc';
  description: string;
  ports: PortSpec[];
  params: ParamSpec[];
  /** Default tile size on canvas (world units). */
  width: number;
  height: number;
  /** Initial non-scalar state (e.g. sequencer steps); serialized with the patch. */
  defaultData?: () => Record<string, unknown>;
}

export interface ModuleInstance {
  id: string;
  type: string;
  x: number;
  y: number;
  label?: string;
  /** User tint color (PRD §6) as 24-bit RGB, undefined = theme default. */
  color?: number;
  params: Record<string, number>;
  /** Non-scalar module state (e.g. sequencer steps). */
  data?: Record<string, unknown>;
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
