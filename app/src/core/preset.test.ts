import { describe, expect, it } from 'vitest';
import { Graph } from './graph';
import { createInstance } from './module';
import { MODULE_DEFS } from './registry';
import {
  applyPreset,
  captureLivePreset,
  liveMatchesPreset,
  randomizeLive,
  remapPreset,
  type PresetTarget,
} from './preset';

function synthGraph() {
  const graph = new Graph(MODULE_DEFS);
  const osc = createInstance(MODULE_DEFS.get('osc')!, 0, 0);
  const lfo = createInstance(MODULE_DEFS.get('lfo')!, 200, 0);
  const vcf = createInstance(MODULE_DEFS.get('vcf')!, 400, 0);
  graph.addModule(osc);
  graph.addModule(lfo);
  graph.addModule(vcf);
  graph.connect({ moduleId: lfo.id, portId: 'out' }, { moduleId: vcf.id, portId: 'mod' });
  const group = graph.createGroup('Synth', [osc.id, lfo.id, vcf.id], [], 0, 0);
  return { graph, osc, lfo, vcf, group };
}

describe('captureLivePreset', () => {
  it('snapshots a plain module params + data', () => {
    const { graph, osc } = synthGraph();
    graph.modules.get(osc.id)!.params.octave = 2;
    const snap = captureLivePreset(graph, { id: osc.id, isGroup: false });
    expect(snap.params!.octave).toBe(2);
    expect(snap.members).toBeUndefined();
  });

  it('snapshots container members and internal wires only', () => {
    const { graph, osc, lfo, vcf, group } = synthGraph();
    // External wire out of the group must NOT be captured.
    const out = createInstance(MODULE_DEFS.get('audioOut')!, 600, 0);
    graph.addModule(out);
    graph.connect({ moduleId: vcf.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });

    const snap = captureLivePreset(graph, { id: group.id, isGroup: true });
    expect(Object.keys(snap.members!).sort()).toEqual([osc.id, lfo.id, vcf.id].sort());
    expect(snap.wires).toEqual([
      { from: { moduleId: lfo.id, portId: 'out' }, to: { moduleId: vcf.id, portId: 'mod' } },
    ]);
  });
});

describe('applyPreset', () => {
  it('overlays module params, keeps params absent from the preset', () => {
    const { graph, osc } = synthGraph();
    const t: PresetTarget = { id: osc.id, isGroup: false };
    graph.modules.get(osc.id)!.params.octave = 3;
    applyPreset(graph, t, { id: 'p', name: 'x', category: 'c', params: { wave: 0 } });
    expect(graph.modules.get(osc.id)!.params.wave).toBe(0);
    expect(graph.modules.get(osc.id)!.params.octave).toBe(3); // untouched
  });

  it('replaces internal wiring, leaves crossing wires intact', () => {
    const { graph, osc, lfo, vcf, group } = synthGraph();
    const out = createInstance(MODULE_DEFS.get('audioOut')!, 600, 0);
    graph.addModule(out);
    graph.connect({ moduleId: vcf.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
    const t: PresetTarget = { id: group.id, isGroup: true };

    // Preset rewires lfo → osc pitch instead of lfo → vcf mod.
    applyPreset(graph, t, {
      id: 'p', name: 'x', category: 'c',
      members: {},
      wires: [{ from: { moduleId: lfo.id, portId: 'out' }, to: { moduleId: osc.id, portId: 'pitch' } }],
    });

    const internal = [...graph.wires.values()].filter(
      (w) => w.to.moduleId !== out.id,
    );
    expect(internal).toHaveLength(1);
    expect(internal[0].to).toEqual({ moduleId: osc.id, portId: 'pitch' });
    // Crossing wire to audioOut survived.
    expect([...graph.wires.values()].some((w) => w.to.moduleId === out.id)).toBe(true);
  });
});

describe('liveMatchesPreset (dirty)', () => {
  it('round-trips clean, dirties on a param change', () => {
    const { graph, group } = synthGraph();
    const t: PresetTarget = { id: group.id, isGroup: true };
    const preset = { id: 'p', name: 'x', category: 'c', ...captureLivePreset(graph, t) };
    expect(liveMatchesPreset(graph, t, preset)).toBe(true);
    graph.modules.get(group.moduleIds[0])!.params.octave = 1;
    expect(liveMatchesPreset(graph, t, preset)).toBe(false);
  });

  it('dirties when an internal wire changes', () => {
    const { graph, lfo, vcf, group } = synthGraph();
    const t: PresetTarget = { id: group.id, isGroup: true };
    const preset = { id: 'p', name: 'x', category: 'c', ...captureLivePreset(graph, t) };
    const wire = [...graph.wires.values()].find(
      (w) => w.from.moduleId === lfo.id && w.to.moduleId === vcf.id,
    )!;
    graph.disconnect(wire.id);
    expect(liveMatchesPreset(graph, t, preset)).toBe(false);
  });
});

describe('randomizeLive', () => {
  it('only touches randomizable params', () => {
    const { graph, osc } = synthGraph();
    const m = graph.modules.get(osc.id)!;
    m.params.level = 0.8; // level is randomizable:false
    randomizeLive(graph, { id: osc.id, isGroup: false });
    expect(m.params.level).toBe(0.8);
  });
});

describe('remapPreset', () => {
  it('drops members and wires for unmapped ids', () => {
    const map = new Map([['a', 'A']]);
    const out = remapPreset(
      {
        id: 'p', name: 'x', category: 'c',
        members: { a: { params: { v: 1 } }, b: { params: { v: 2 } } },
        wires: [
          { from: { moduleId: 'a', portId: 'o' }, to: { moduleId: 'a', portId: 'i' } },
          { from: { moduleId: 'a', portId: 'o' }, to: { moduleId: 'b', portId: 'i' } },
        ],
      },
      map,
    );
    expect(Object.keys(out.members!)).toEqual(['A']);
    expect(out.wires).toEqual([{ from: { moduleId: 'A', portId: 'o' }, to: { moduleId: 'A', portId: 'i' } }]);
  });
});
