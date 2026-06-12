import { describe, expect, it } from 'vitest';
import { buildAiContext, buildVisContext, withContext } from './aicontext';
import { Graph } from './graph';
import { createInstance } from './module';
import { MODULE_DEFS } from './registry';

describe('buildAiContext', () => {
  it('summarizes modules and wires', () => {
    const graph = new Graph(MODULE_DEFS);
    expect(buildAiContext(graph)).toContain('empty canvas');
    const a = createInstance(MODULE_DEFS.get('osc')!, 0, 0);
    const b = createInstance(MODULE_DEFS.get('osc')!, 0, 100);
    const out = createInstance(MODULE_DEFS.get('audioOut')!, 200, 0);
    for (const m of [a, b, out]) graph.addModule(m);
    graph.connect({ moduleId: a.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
    const ctx = buildAiContext(graph);
    expect(ctx).toContain('osc×2');
    expect(ctx).toContain('audioOut');
    expect(ctx).toContain('1 wires');
  });
});

describe('buildVisContext', () => {
  it('reports pole wiring and embeds the current graph', () => {
    const graph = new Graph(MODULE_DEFS);
    const synth = createInstance(MODULE_DEFS.get('osc')!, 0, 0);
    const vis = createInstance(MODULE_DEFS.get('visualizer')!, 200, 0);
    graph.addModule(synth);
    graph.addModule(vis);
    graph.connect({ moduleId: synth.id, portId: 'out' }, { moduleId: vis.id, portId: 'in' });
    const ctx = buildVisContext(graph, vis.id);
    expect(ctx).toContain('audio: yes');
    expect(ctx).toContain('text: no');
    expect(ctx).toContain('"type":"spectrum"'); // init graph embedded
  });
});

describe('withContext', () => {
  it('separates context from the request', () => {
    expect(withContext('CTX', 'do it')).toBe('CTX\n\nRequest: do it');
  });
});
