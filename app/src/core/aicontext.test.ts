import { describe, expect, it } from 'vitest';
import { buildAiContext, buildGroupContext, buildVisContext, withContext } from './aicontext';
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

describe('buildGroupContext', () => {
  /** A group with one inner wire, one external wire, and (optionally) a face. */
  function setup() {
    const graph = new Graph(MODULE_DEFS);
    const osc = createInstance(MODULE_DEFS.get('osc')!, 100, 50);
    const out = createInstance(MODULE_DEFS.get('audioOut')!, 400, 50);
    const lfo = createInstance(MODULE_DEFS.get('lfo')!, -300, 0); // outside
    for (const m of [osc, out, lfo]) graph.addModule(m);
    graph.connect({ moduleId: osc.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
    const ext = graph.connect({ moduleId: lfo.id, portId: 'out' }, { moduleId: osc.id, portId: 'pitch' });
    expect(ext.ok).toBe(true);
    const group = graph.createGroup('Synth', [osc.id, out.id], [], 100, 50);
    return { graph, osc, out, lfo, group };
  }

  function contextJson(ctx: string): Record<string, unknown> {
    const m = ctx.match(/```json\n(.*?)\n```/s);
    expect(m).not.toBeNull();
    return JSON.parse(m![1]);
  }

  it('serializes the group in .kkgroup shape with real instance ids', () => {
    const { graph, osc, out, group } = setup();
    const doc = contextJson(buildGroupContext(graph, group.id));
    expect(doc.kind).toBe('kkgroup');
    expect(doc.name).toBe('Synth');
    const modules = doc.modules as Array<{ id: string; type: string }>;
    expect(modules.map((m) => m.id).sort()).toEqual([osc.id, out.id].sort());
    const wires = doc.wires as Array<{ from: { module: string } }>;
    expect(wires).toHaveLength(1); // only the internal wire
    expect(wires[0].from.module).toBe(osc.id);
  });

  it('lists only non-default params', () => {
    const { graph, osc, group } = setup();
    const def = MODULE_DEFS.get('osc')!;
    const fine = def.params.find((p) => p.id === 'fine')!;
    graph.modules.get(osc.id)!.params.fine = fine.default + 0.1;
    const doc = contextJson(buildGroupContext(graph, group.id));
    const mod = (doc.modules as Array<{ id: string; params?: Record<string, number> }>).find(
      (m) => m.id === osc.id,
    )!;
    expect(mod.params).toEqual({ fine: fine.default + 0.1 });
  });

  it('includes the face in spec format (module/param keys)', () => {
    const { graph, osc, group } = setup();
    group.face = {
      width: 320,
      height: 200,
      grid: 10,
      snap: true,
      elements: [
        { id: 'e1', kind: 'knob', x: 16, y: 28, w: 70, h: 86, label: 'Tune', moduleId: osc.id, paramId: 'fine' },
      ],
    };
    const doc = contextJson(buildGroupContext(graph, group.id));
    const face = doc.face as { elements: Array<Record<string, unknown>> };
    expect(face.elements).toEqual([
      { kind: 'knob', x: 16, y: 28, w: 70, h: 86, label: 'Tune', module: osc.id, param: 'fine' },
    ]);
  });

  it('marks externally wired boundary ports so the model keeps those ids', () => {
    const { graph, osc, group } = setup();
    const ctx = buildGroupContext(graph, group.id);
    const poleLine = ctx.split('\n').find((l) => l.includes(`${osc.id}.pitch`));
    expect(poleLine).toContain('WIRED on the main canvas');
  });

  it('returns empty for an unknown group', () => {
    const { graph } = setup();
    expect(buildGroupContext(graph, 'nope')).toBe('');
  });
});

describe('withContext', () => {
  it('separates context from the request', () => {
    expect(withContext('CTX', 'do it')).toBe('CTX\n\nRequest: do it');
  });
});
