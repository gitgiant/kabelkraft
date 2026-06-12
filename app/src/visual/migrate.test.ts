import { describe, expect, it } from 'vitest';
import { MODULE_DEFS } from '../core/registry';
import { deserializeProject } from '../core/serialize';
import { DEFAULT_TRANSPORT } from '../core/types';
import {
  approximateScene,
  approximateScenes,
  initVisGraph,
  isVisGraph,
  sanitizeVisGraph,
  sceneToGraph,
} from './migrate';
import { VIS_NODE_DEFS } from './registry';
import type { VisGraphData } from './types';

describe('visual graph synthesis', () => {
  it('init graph is spectrum → output with valid node types and wire ends', () => {
    const g = initVisGraph();
    expect(g.nodes.map((n) => n.type)).toEqual(['spectrum', 'output']);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const w of g.wires) {
      expect(ids.has(w.from.nodeId)).toBe(true);
      expect(ids.has(w.to.nodeId)).toBe(true);
    }
    expect(VIS_NODE_DEFS.has(g.nodes[0].type)).toBe(true);
  });

  it('maps legacy scenes to source nodes and carries gain', () => {
    expect(sceneToGraph(0, 2).nodes[0]).toMatchObject({ type: 'scope', params: { gain: 2 } });
    expect(sceneToGraph(1, 1.5).nodes[0].type).toBe('spectrum');
    expect(sceneToGraph(2, 3).nodes[0].type).toBe('particles');
  });

  it('clamps out-of-range and non-numeric scene/gain', () => {
    expect(sceneToGraph(99, 99).nodes[0]).toMatchObject({ type: 'particles', params: { gain: 4 } });
    expect(sceneToGraph(-1, 0).nodes[0]).toMatchObject({ type: 'scope', params: { gain: 0.5 } });
    expect(sceneToGraph(undefined, 'x').nodes[0]).toMatchObject({ type: 'scope', params: { gain: 1.5 } });
  });

  it('approximateScene finds the first source node, defaulting to spectrum', () => {
    expect(approximateScene(sceneToGraph(2, 2.5))).toEqual({ scene: 'particles', gain: 2.5 });
    expect(approximateScene(null)).toEqual({ scene: 'spectrum', gain: 1.5 });
    expect(approximateScene({ nodes: [{ id: 'v1', type: 'output', x: 0, y: 0, params: {} }], wires: [] }))
      .toEqual({ scene: 'spectrum', gain: 1.5 });
  });

  it('approximateScenes layers every recognized source type once, ignoring effects', () => {
    const g: VisGraphData = {
      nodes: [
        { id: 'v1', type: 'scope', x: 0, y: 0, params: { gain: 2 } },
        { id: 'v2', type: 'bloom', x: 0, y: 0, params: {} },
        { id: 'v3', type: 'particles', x: 0, y: 0, params: {} },
        { id: 'v4', type: 'scope', x: 0, y: 0, params: { gain: 9 } }, // dup type — first wins
        { id: 'v5', type: 'output', x: 0, y: 0, params: {} },
      ],
      wires: [],
    };
    expect(approximateScenes(g)).toEqual([
      { scene: 'scope', gain: 2 },
      { scene: 'particles', gain: 1.5 },
    ]);
    expect(approximateScenes(null)).toEqual([{ scene: 'spectrum', gain: 1.5 }]);
  });

  it('sanitize drops unknown nodes and orphaned wires', () => {
    const g: VisGraphData = {
      nodes: [
        { id: 'v1', type: 'spectrum', x: 0, y: 0, params: {} },
        { id: 'v2', type: 'wormhole3d', x: 0, y: 0, params: {} },
        { id: 'v3', type: 'output', x: 0, y: 0, params: {} },
      ],
      wires: [
        { id: 'w1', from: { nodeId: 'v1', portId: 'out' }, to: { nodeId: 'v3', portId: 'in' } },
        { id: 'w2', from: { nodeId: 'v2', portId: 'out' }, to: { nodeId: 'v3', portId: 'in' } },
      ],
    };
    const { graph, dropped } = sanitizeVisGraph(g);
    expect(graph.nodes.map((n) => n.id)).toEqual(['v1', 'v3']);
    expect(graph.wires.map((w) => w.id)).toEqual(['w1']);
    expect(dropped).toBe(2);
  });
});

describe('project-load migration', () => {
  function projectWith(module: Record<string, unknown>): string {
    return JSON.stringify({
      formatVersion: 1,
      name: 'T',
      transport: DEFAULT_TRANSPORT,
      modules: [module],
      wires: [],
    });
  }

  it('legacy visualizer (scene/gain params, no graph) gains a synthesized graph', () => {
    const json = projectWith({
      id: 'm1',
      type: 'visualizer',
      x: 0,
      y: 0,
      params: { scene: 2, gain: 2 },
    });
    const result = deserializeProject(json, MODULE_DEFS);
    const mod = result.graph.modules.get('m1')!;
    expect(isVisGraph(mod.data?.graph)).toBe(true);
    const g = mod.data!.graph as VisGraphData;
    expect(g.nodes[0]).toMatchObject({ type: 'particles', params: { gain: 2 } });
    expect(result.warnings.some((w) => w.includes('legacy scene'))).toBe(true);
  });

  it('modern visualizer graphs load untouched, no warning', () => {
    const graph = sceneToGraph(0, 3);
    const json = projectWith({
      id: 'm1',
      type: 'visualizer',
      x: 0,
      y: 0,
      params: {},
      data: { graph },
    });
    const result = deserializeProject(json, MODULE_DEFS);
    expect(result.graph.modules.get('m1')!.data?.graph).toEqual(graph);
    expect(result.warnings).toEqual([]);
  });

  it('graphs with unknown node types are sanitized with a warning', () => {
    const json = projectWith({
      id: 'm1',
      type: 'visualizer',
      x: 0,
      y: 0,
      params: {},
      data: {
        graph: {
          nodes: [
            { id: 'v1', type: 'wormhole3d', x: 0, y: 0, params: {} },
            { id: 'v2', type: 'output', x: 0, y: 0, params: {} },
          ],
          wires: [],
        },
      },
    });
    const result = deserializeProject(json, MODULE_DEFS);
    const g = result.graph.modules.get('m1')!.data!.graph as VisGraphData;
    expect(g.nodes.map((n) => n.type)).toEqual(['output']);
    expect(result.warnings.some((w) => w.includes('unknown visual node'))).toBe(true);
  });

  it('fresh visualizer instances start with the init graph', () => {
    const def = MODULE_DEFS.get('visualizer')!;
    expect(def.params).toEqual([]);
    const data = def.defaultData!();
    expect(isVisGraph(data.graph)).toBe(true);
    expect((data.graph as VisGraphData).nodes[0].type).toBe('spectrum');
  });
});
