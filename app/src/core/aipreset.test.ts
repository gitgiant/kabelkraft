import { describe, expect, it } from 'vitest';
import { Graph } from './graph';
import { createInstance } from './module';
import { MODULE_DEFS } from './registry';
import { generatePresetSpecPack, parseKkPreset } from './aipreset';
import type { PresetTarget } from './preset';

function synthGraph() {
  const graph = new Graph(MODULE_DEFS);
  const osc = createInstance(MODULE_DEFS.get('osc')!, 0, 0);
  const lfo = createInstance(MODULE_DEFS.get('lfo')!, 0, 0);
  const vcf = createInstance(MODULE_DEFS.get('vcf')!, 0, 0);
  graph.addModule(osc);
  graph.addModule(lfo);
  graph.addModule(vcf);
  graph.connect({ moduleId: lfo.id, portId: 'out' }, { moduleId: vcf.id, portId: 'mod' });
  const group = graph.createGroup('Synth', [osc.id, lfo.id, vcf.id], [], 0, 0);
  return { graph, osc, lfo, vcf, group };
}

describe('generatePresetSpecPack', () => {
  it('lists member ids, params, ports and current wiring for a container', () => {
    const { graph, osc, lfo, vcf, group } = synthGraph();
    const spec = generatePresetSpecPack(graph, { id: group.id, isGroup: true });
    expect(spec).toContain(`id "${osc.id}"`);
    expect(spec).toContain('cutoff');
    expect(spec).toContain('ports:');
    expect(spec).toContain(`${lfo.id}.out → ${vcf.id}.mod`);
  });

  it('omits wiring section for a plain module', () => {
    const { graph, osc } = synthGraph();
    const spec = generatePresetSpecPack(graph, { id: osc.id, isGroup: false });
    expect(spec).not.toContain('Current internal wiring');
    expect(spec).toContain('one module and no wiring');
  });
});

describe('parseKkPreset', () => {
  it('validates a container reply: clamps params, keeps valid wires', () => {
    const { graph, osc, lfo, vcf, group } = synthGraph();
    const t: PresetTarget = { id: group.id, isGroup: true };
    const reply = JSON.stringify({
      kind: 'kkpreset',
      name: 'Bass',
      category: 'Bass',
      members: { [vcf.id]: { params: { cutoff: 99999, mode: 1 } } },
      wires: [{ from: { module: lfo.id, port: 'out' }, to: { module: osc.id, port: 'pitch' } }],
    });
    const r = parseKkPreset(reply, graph, t);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('Bass');
    expect(r.preset!.members![vcf.id].params.cutoff).toBe(18000); // clamped to max
    expect(r.preset!.wires).toEqual([
      { from: { moduleId: lfo.id, portId: 'out' }, to: { moduleId: osc.id, portId: 'pitch' } },
    ]);
  });

  it('drops invalid wires (type mismatch, non-member, double control-in)', () => {
    const { graph, osc, lfo, vcf, group } = synthGraph();
    const t: PresetTarget = { id: group.id, isGroup: true };
    const reply = JSON.stringify({
      kind: 'kkpreset',
      members: { [osc.id]: { params: { octave: 1 } } },
      wires: [
        { from: { module: osc.id, port: 'out' }, to: { module: vcf.id, port: 'mod' } }, // audio→control mismatch
        { from: { module: lfo.id, port: 'out' }, to: { module: 'ghost', port: 'mod' } }, // non-member
        { from: { module: lfo.id, port: 'out' }, to: { module: vcf.id, port: 'mod' } }, // ok
        { from: { module: lfo.id, port: 'out' }, to: { module: vcf.id, port: 'mod' } }, // dup control-in
      ],
    });
    const r = parseKkPreset(reply, graph, t);
    expect(r.ok).toBe(true);
    expect(r.preset!.wires).toEqual([
      { from: { moduleId: lfo.id, portId: 'out' }, to: { moduleId: vcf.id, portId: 'mod' } },
    ]);
    expect(r.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('returns params for a plain-module target', () => {
    const { graph, osc } = synthGraph();
    const t: PresetTarget = { id: osc.id, isGroup: false };
    const r = parseKkPreset(
      JSON.stringify({ kind: 'kkpreset', members: { [osc.id]: { params: { wave: 0, bogus: 5 } } } }),
      graph,
      t,
    );
    expect(r.ok).toBe(true);
    expect(r.preset!.params).toEqual({ wave: 0 });
    expect(r.preset!.members).toBeUndefined();
  });

  it('errors on an empty reply', () => {
    const { graph, group } = synthGraph();
    const r = parseKkPreset(JSON.stringify({ kind: 'kkpreset', members: {} }), graph, {
      id: group.id,
      isGroup: true,
    });
    expect(r.ok).toBe(false);
  });
});
