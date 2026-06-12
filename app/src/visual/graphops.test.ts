import { describe, expect, it } from 'vitest';
import { featureValue, resolveParams, topoOrder } from './graphops';
import { VIS_NODE_DEFS, visualInPorts } from './registry';
import type { VisFeatures, VisGraphData, VisNodeInstance } from './types';

function node(id: string, type: string, params: Record<string, number> = {}): VisNodeInstance {
  return { id, type, x: 0, y: 0, params };
}

function wire(id: string, from: [string, string], to: [string, string]) {
  return { id, from: { nodeId: from[0], portId: from[1] }, to: { nodeId: to[0], portId: to[1] } };
}

const FEATURES: VisFeatures = {
  wave: new Float32Array(0),
  waveL: new Float32Array(0),
  waveR: new Float32Array(0),
  spectrum: new Float32Array(0),
  level: 0.25,
  peak: 0.5,
  bands: { bass: 0.8, mid: 0.4, high: 0.1 },
  onset: 0.9,
  centroid: 0.5,
  notes: [],
  ctrl: -1,
  text: '',
  textStack: [],
};

describe('topoOrder', () => {
  it('orders dependencies before dependents (diamond)', () => {
    const g: VisGraphData = {
      nodes: [node('out', 'output'), node('blend', 'blend'), node('a', 'spectrum'), node('b', 'scope')],
      wires: [
        wire('w1', ['a', 'out'], ['blend', 'a']),
        wire('w2', ['b', 'out'], ['blend', 'b']),
        wire('w3', ['blend', 'out'], ['out', 'in']),
      ],
    };
    const order = topoOrder(g).map((n) => n.id);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('blend'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('blend'));
    expect(order.indexOf('blend')).toBeLessThan(order.indexOf('out'));
    expect(order).toHaveLength(4);
  });

  it('omits nodes caught in a cycle, keeps the rest', () => {
    const g: VisGraphData = {
      nodes: [node('a', 'blur'), node('b', 'warp'), node('c', 'spectrum')],
      wires: [wire('w1', ['a', 'out'], ['b', 'in']), wire('w2', ['b', 'out'], ['a', 'in'])],
    };
    const order = topoOrder(g).map((n) => n.id);
    expect(order).toEqual(['c']);
  });
});

describe('resolveParams', () => {
  it('falls back to def defaults and keeps stored values', () => {
    const g: VisGraphData = { nodes: [node('s', 'spectrum', { gain: 2.5 })], wires: [] };
    expect(resolveParams(g, g.nodes[0], null).gain).toBe(2.5);
    const g2: VisGraphData = { nodes: [node('s', 'spectrum')], wires: [] };
    expect(resolveParams(g2, g2.nodes[0], null).gain).toBe(1.5);
  });

  it('multiplies a param by its wired control value', () => {
    const g: VisGraphData = {
      nodes: [node('f', 'features'), node('e', 'blur', { amount: 0.5 })],
      wires: [wire('w1', ['f', 'bass'], ['e', 'amount'])],
    };
    expect(resolveParams(g, g.nodes[1], FEATURES).amount).toBeCloseTo(0.5 * 0.8, 5);
    // No features yet → modulated to zero, unwired params untouched.
    expect(resolveParams(g, g.nodes[1], null).amount).toBe(0);
  });

  it('feature values map ports correctly', () => {
    expect(featureValue(FEATURES, 'bass')).toBe(0.8);
    expect(featureValue(FEATURES, 'onset')).toBe(0.9);
    expect(featureValue(FEATURES, 'level')).toBeCloseTo(0.55, 5);
    expect(featureValue(null, 'bass')).toBe(0);
  });

  it('ctrl (Mod pole) passes through, neutral 1 when the pole is unwired', () => {
    expect(featureValue({ ...FEATURES, ctrl: 0.4 }, 'ctrl')).toBe(0.4);
    expect(featureValue({ ...FEATURES, ctrl: -1 }, 'ctrl')).toBe(1);
  });
});

describe('node def sanity', () => {
  it('defs are well-formed (key match, param ranges, option counts, mod ports)', () => {
    for (const [key, def] of VIS_NODE_DEFS) {
      expect(def.type).toBe(key);
      const paramIds = new Set(def.params.map((p) => p.id));
      for (const p of def.params) {
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
        if (p.options) expect(p.options.length - 1).toBe(p.max);
      }
      for (const port of def.ports) {
        if (port.type === 'control' && port.direction === 'in') {
          // Mod-port convention: id matches the param it scales.
          expect(paramIds.has(port.id)).toBe(true);
        }
      }
      if (def.type !== 'features' && def.type !== 'output') {
        expect(def.ports.some((p) => p.type === 'visual' && p.direction === 'out')).toBe(true);
      }
    }
  });

  it('blend exposes two visual inputs in a/b order', () => {
    const ins = visualInPorts(VIS_NODE_DEFS.get('blend')!).map((p) => p.id);
    expect(ins).toEqual(['a', 'b']);
  });
});
