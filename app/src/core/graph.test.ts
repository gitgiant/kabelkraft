import { describe, expect, it } from 'vitest';
import { planAutoWire } from './autowire';
import { Graph } from './graph';
import { createInstance } from './module';
import { MODULE_DEFS } from './registry';
import { deserializeProject, serializeProject } from './serialize';
import { DEFAULT_TRANSPORT } from './types';

function setup() {
  const graph = new Graph(MODULE_DEFS);
  const synth = createInstance(MODULE_DEFS.get('smpl')!, 0, 0);
  const synth2 = createInstance(MODULE_DEFS.get('smpl')!, 0, 200);
  const keyboard = createInstance(MODULE_DEFS.get('keyboard')!, -300, 0);
  const audioOut = createInstance(MODULE_DEFS.get('audioOut')!, 300, 0);
  const levels = createInstance(MODULE_DEFS.get('levels')!, 300, 200);
  for (const m of [synth, synth2, keyboard, audioOut, levels]) graph.addModule(m);
  return { graph, synth, synth2, keyboard, audioOut, levels };
}

describe('connection rules (PRD §4.3)', () => {
  it('connects same-type output to input', () => {
    const { graph, synth, audioOut } = setup();
    const result = graph.connect(
      { moduleId: synth.id, portId: 'out' },
      { moduleId: audioOut.id, portId: 'in' },
    );
    expect(result.ok).toBe(true);
    expect(graph.wires.size).toBe(1);
  });

  it('rejects type mismatch (note output into audio input)', () => {
    const { graph, keyboard, audioOut } = setup();
    const result = graph.connect(
      { moduleId: keyboard.id, portId: 'notes' },
      { moduleId: audioOut.id, portId: 'in' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Type mismatch/);
  });

  it('rejects output-to-output and input-to-input', () => {
    const { graph, synth, synth2, audioOut, levels } = setup();
    expect(
      graph.connect({ moduleId: synth.id, portId: 'out' }, { moduleId: synth2.id, portId: 'out' }).ok,
    ).toBe(false);
    expect(
      graph.connect({ moduleId: audioOut.id, portId: 'in' }, { moduleId: levels.id, portId: 'in' }).ok,
    ).toBe(false);
  });

  it('allows fan-out: one output feeds many inputs', () => {
    const { graph, synth, audioOut, levels } = setup();
    const out = { moduleId: synth.id, portId: 'out' };
    expect(graph.connect(out, { moduleId: audioOut.id, portId: 'in' }).ok).toBe(true);
    expect(graph.connect(out, { moduleId: levels.id, portId: 'in' }).ok).toBe(true);
    expect(graph.wiresOutOf(out)).toHaveLength(2);
  });

  it('allows audio fan-in: multiple wires sum into one input', () => {
    const { graph, synth, synth2, audioOut } = setup();
    const input = { moduleId: audioOut.id, portId: 'in' };
    expect(graph.connect({ moduleId: synth.id, portId: 'out' }, input).ok).toBe(true);
    expect(graph.connect({ moduleId: synth2.id, portId: 'out' }, input).ok).toBe(true);
    expect(graph.wiresInto(input)).toHaveLength(2);
  });

  it('allows note fan-in: events merge', () => {
    const { graph, synth, keyboard } = setup();
    const kb2 = createInstance(MODULE_DEFS.get('keyboard')!, -300, 200);
    graph.addModule(kb2);
    const input = { moduleId: synth.id, portId: 'notes' };
    expect(graph.connect({ moduleId: keyboard.id, portId: 'notes' }, input).ok).toBe(true);
    expect(graph.connect({ moduleId: kb2.id, portId: 'notes' }, input).ok).toBe(true);
    expect(graph.wiresInto(input)).toHaveLength(2);
  });

  it('rejects duplicate wires', () => {
    const { graph, synth, audioOut } = setup();
    const from = { moduleId: synth.id, portId: 'out' };
    const to = { moduleId: audioOut.id, portId: 'in' };
    expect(graph.connect(from, to).ok).toBe(true);
    const dup = graph.connect(from, to);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toMatch(/Already connected/);
  });

  it('control fan-in is single-wire: last connected wins, old wire detached', () => {
    const defs = new Map(MODULE_DEFS);
    defs.set('testLfo', {
      type: 'testLfo', name: 'LFO', category: 'data', description: '', width: 100, height: 100,
      ports: [{ id: 'out', label: 'Out', type: 'control', direction: 'out', description: '' }],
      params: [],
    });
    defs.set('testTarget', {
      type: 'testTarget', name: 'Target', category: 'effect', description: '', width: 100, height: 100,
      ports: [{ id: 'mod', label: 'Mod', type: 'control', direction: 'in', description: '' }],
      params: [],
    });
    const graph = new Graph(defs);
    const lfo1 = createInstance(defs.get('testLfo')!, 0, 0);
    const lfo2 = createInstance(defs.get('testLfo')!, 0, 100);
    const target = createInstance(defs.get('testTarget')!, 200, 0);
    for (const m of [lfo1, lfo2, target]) graph.addModule(m);

    const input = { moduleId: target.id, portId: 'mod' };
    const first = graph.connect({ moduleId: lfo1.id, portId: 'out' }, input);
    expect(first.ok).toBe(true);
    const second = graph.connect({ moduleId: lfo2.id, portId: 'out' }, input);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.detached?.from.moduleId).toBe(lfo1.id);
    }
    expect(graph.wiresInto(input)).toHaveLength(1);
  });

  it('removing a module removes its wires', () => {
    const { graph, synth, audioOut } = setup();
    graph.connect({ moduleId: synth.id, portId: 'out' }, { moduleId: audioOut.id, portId: 'in' });
    const removed = graph.removeModule(synth.id);
    expect(removed).toHaveLength(1);
    expect(graph.wires.size).toBe(0);
  });
});

describe('module groups (PRD §6)', () => {
  it('groups, nests, and resolves visibility through collapsed ancestors', () => {
    const { graph, synth, synth2, keyboard } = setup();
    const inner = graph.createGroup('Inner', [synth.id, synth2.id], [], 0, 0);
    expect(graph.groupOfModule(synth.id)?.id).toBe(inner.id);
    expect(graph.hiddenBehind(synth.id)?.id).toBe(inner.id); // collapsed by default

    inner.collapsed = false;
    expect(graph.hiddenBehind(synth.id)).toBeUndefined();

    const outer = graph.createGroup('Outer', [keyboard.id], [inner.id], 0, 0);
    expect(graph.parentGroup(inner.id)?.id).toBe(outer.id);
    // Outer collapsed hides synth even though inner is expanded.
    expect(graph.hiddenBehind(synth.id)?.id).toBe(outer.id);
    expect([...graph.modulesInGroup(outer.id)]).toContain(synth.id);
    expect([...graph.modulesInGroup(outer.id)]).toContain(keyboard.id);
  });

  it('dissolving a nested group reparents members to the parent', () => {
    const { graph, synth, synth2, keyboard } = setup();
    const inner = graph.createGroup('Inner', [synth.id, synth2.id], [], 0, 0);
    const outer = graph.createGroup('Outer', [keyboard.id], [inner.id], 0, 0);
    graph.dissolveGroup(inner.id);
    expect(graph.groups.has(inner.id)).toBe(false);
    expect(outer.moduleIds).toContain(synth.id);
    expect(graph.groupOfModule(synth.id)?.id).toBe(outer.id);
  });

  it('removing a module removes it from its group', () => {
    const { graph, synth, synth2 } = setup();
    const group = graph.createGroup('G', [synth.id, synth2.id], [], 0, 0);
    graph.removeModule(synth.id);
    expect(group.moduleIds).toEqual([synth2.id]);
  });

  it('groups round-trip through serialization', () => {
    const { graph, synth, synth2, keyboard } = setup();
    const inner = graph.createGroup('Inner', [synth.id, synth2.id], [], 10, 20);
    inner.collapsed = false;
    graph.createGroup('Outer', [keyboard.id], [inner.id], 30, 40);
    const json = serializeProject('Test', graph, DEFAULT_TRANSPORT);
    const loaded = deserializeProject(json, MODULE_DEFS);
    expect(loaded.graph.groups.size).toBe(2);
    const loadedInner = loaded.graph.groups.get(inner.id)!;
    expect(loadedInner.collapsed).toBe(false);
    expect(loadedInner.moduleIds).toEqual([synth.id, synth2.id]);
    expect(loaded.graph.parentGroup(inner.id)?.name).toBe('Outer');
  });
});

describe('project serialization (PRD §15)', () => {
  it('round-trips modules, wires, params, transport', () => {
    const { graph, synth, keyboard, audioOut } = setup();
    graph.connect({ moduleId: keyboard.id, portId: 'notes' }, { moduleId: synth.id, portId: 'notes' });
    graph.connect({ moduleId: synth.id, portId: 'out' }, { moduleId: audioOut.id, portId: 'in' });
    synth.params.attack = 0.5;

    const json = serializeProject('Test', graph, { ...DEFAULT_TRANSPORT, tempo: 140 });
    const loaded = deserializeProject(json, MODULE_DEFS);

    expect(loaded.warnings).toEqual([]);
    expect(loaded.name).toBe('Test');
    expect(loaded.transport.tempo).toBe(140);
    expect(loaded.transport.playing).toBe(false);
    expect(loaded.graph.modules.size).toBe(graph.modules.size);
    expect(loaded.graph.wires.size).toBe(2);
    expect(loaded.graph.modules.get(synth.id)?.params.attack).toBe(0.5);
  });

  it('skips unknown module types with a warning, drops their wires', () => {
    const { graph, synth, audioOut } = setup();
    graph.connect({ moduleId: synth.id, portId: 'out' }, { moduleId: audioOut.id, portId: 'in' });
    const json = serializeProject('Test', graph, DEFAULT_TRANSPORT);
    const tampered = json.replace(`"type": "${'smpl'}"`, '"type": "superSaw"');
    const loaded = deserializeProject(tampered, MODULE_DEFS);
    expect(loaded.warnings.some((w) => w.includes('superSaw'))).toBe(true);
    expect(loaded.graph.wires.size).toBe(0);
  });
});

describe('intrinsic group poles (tint)', () => {
  function setupVis() {
    const graph = new Graph(MODULE_DEFS);
    const vis = createInstance(MODULE_DEFS.get('visualizer')!, -300, 0);
    const vis2 = createInstance(MODULE_DEFS.get('visualizer')!, -300, 300);
    const knob = createInstance(MODULE_DEFS.get('knob')!, 0, 0);
    const lfo = createInstance(MODULE_DEFS.get('lfo')!, 0, 300);
    for (const m of [vis, vis2, knob, lfo]) graph.addModule(m);
    const group = graph.createGroup('G', [knob.id, lfo.id], [], 0, 0);
    return { graph, vis, vis2, knob, lfo, group };
  }

  it('every group exposes an intrinsic visual tint-in pole', () => {
    const { graph, group } = setupVis();
    const tint = graph.groupPoles(group.id).find((p) => p.portId === 'tint');
    expect(tint).toBeDefined();
    expect(tint!.moduleId).toBe(group.id);
    expect(tint!.type).toBe('visual');
    expect(tint!.direction).toBe('in');
    expect(tint!.intrinsic).toBe(true);
  });

  it('connects a visual output to the group tint pole; rejects type mismatch', () => {
    const { graph, vis, lfo, group } = setupVis();
    const ok = graph.connect({ moduleId: vis.id, portId: 'vout' }, { moduleId: group.id, portId: 'tint' });
    expect(ok.ok).toBe(true);
    const bad = graph.connect({ moduleId: lfo.id, portId: 'out' }, { moduleId: group.id, portId: 'tint' });
    expect(bad.ok).toBe(false);
  });

  it('tint pole is single fan-in: a second wire detaches the first', () => {
    const { graph, vis, vis2, group } = setupVis();
    graph.connect({ moduleId: vis.id, portId: 'vout' }, { moduleId: group.id, portId: 'tint' });
    const second = graph.connect({ moduleId: vis2.id, portId: 'vout' }, { moduleId: group.id, portId: 'tint' });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.detached?.from.moduleId).toBe(vis.id);
    expect(graph.wiresInto({ moduleId: group.id, portId: 'tint' })).toHaveLength(1);
  });

  it('poleHidden hides the tint pole; wired flag reported in edit info', () => {
    const { graph, vis, group } = setupVis();
    group.poleHidden = [`${group.id}:tint`];
    expect(graph.groupPoles(group.id).some((p) => p.portId === 'tint')).toBe(false);
    expect(
      graph.groupPoleEditInfo(group.id).addable.some((a) => a.key === `${group.id}:tint`),
    ).toBe(true);
    group.poleHidden = [];
    graph.connect({ moduleId: vis.id, portId: 'vout' }, { moduleId: group.id, portId: 'tint' });
    const info = graph.groupPoleEditInfo(group.id);
    expect(info.poles.find((p) => p.key === `${group.id}:tint`)?.wired).toBe(true);
  });

  it('dissolving a group removes wires ending on its poles', () => {
    const { graph, vis, group } = setupVis();
    graph.connect({ moduleId: vis.id, portId: 'vout' }, { moduleId: group.id, portId: 'tint' });
    const removed = graph.dissolveGroup(group.id);
    expect(removed).toHaveLength(1);
    expect(graph.wires.size).toBe(0);
  });

  it('group-endpoint wires round-trip through serialization', () => {
    const { graph, vis, group } = setupVis();
    graph.connect({ moduleId: vis.id, portId: 'vout' }, { moduleId: group.id, portId: 'tint' });
    const json = serializeProject('Tint', graph, DEFAULT_TRANSPORT);
    const loaded = deserializeProject(json, MODULE_DEFS);
    expect(loaded.warnings).toEqual([]);
    const wires = [...loaded.graph.wires.values()];
    expect(wires.some((w) => w.to.moduleId === group.id && w.to.portId === 'tint')).toBe(true);
  });
});

describe('auto-wire planner', () => {
  function planSetup() {
    const graph = new Graph(MODULE_DEFS);
    const keyboard = createInstance(MODULE_DEFS.get('keyboard')!, 0, 0);
    const smpl = createInstance(MODULE_DEFS.get('smpl')!, 300, 0);
    const audioOut = createInstance(MODULE_DEFS.get('audioOut')!, 600, 0);
    for (const m of [keyboard, smpl, audioOut]) graph.addModule(m);
    return { graph, keyboard, smpl, audioOut };
  }

  it('chains selected modules left-to-right by type', () => {
    const { graph, keyboard, smpl, audioOut } = planSetup();
    const plan = planAutoWire(graph, [audioOut.id, keyboard.id, smpl.id]);
    expect(plan).toEqual([
      { from: { moduleId: keyboard.id, portId: 'notes' }, to: { moduleId: smpl.id, portId: 'notes' } },
      { from: { moduleId: smpl.id, portId: 'out' }, to: { moduleId: audioOut.id, portId: 'in' } },
    ]);
  });

  it('planned wires all pass graph.connect', () => {
    const { graph, keyboard, smpl, audioOut } = planSetup();
    for (const p of planAutoWire(graph, [keyboard.id, smpl.id, audioOut.id])) {
      expect(graph.connect(p.from, p.to).ok).toBe(true);
    }
    expect(graph.wires.size).toBe(2);
  });

  it('skips already-wired ports — never steals or duplicates', () => {
    const { graph, keyboard, smpl, audioOut } = planSetup();
    graph.connect({ moduleId: smpl.id, portId: 'out' }, { moduleId: audioOut.id, portId: 'in' });
    const plan = planAutoWire(graph, [keyboard.id, smpl.id, audioOut.id]);
    expect(plan).toEqual([
      { from: { moduleId: keyboard.id, portId: 'notes' }, to: { moduleId: smpl.id, portId: 'notes' } },
    ]);
  });

  it('falls back to right-to-left when left-to-right yields nothing', () => {
    const graph = new Graph(MODULE_DEFS);
    const audioOut = createInstance(MODULE_DEFS.get('audioOut')!, 0, 0);
    const smpl = createInstance(MODULE_DEFS.get('smpl')!, 300, 0);
    for (const m of [audioOut, smpl]) graph.addModule(m);
    const plan = planAutoWire(graph, [audioOut.id, smpl.id]);
    expect(plan).toEqual([
      { from: { moduleId: smpl.id, portId: 'out' }, to: { moduleId: audioOut.id, portId: 'in' } },
    ]);
  });

  it('matches free control inputs in declaration order without touching wired ones', () => {
    const graph = new Graph(MODULE_DEFS);
    const lfo0 = createInstance(MODULE_DEFS.get('lfo')!, -300, 0);
    const lfo = createInstance(MODULE_DEFS.get('lfo')!, 0, 0);
    const wtosc = createInstance(MODULE_DEFS.get('wtosc')!, 300, 0);
    for (const m of [lfo0, lfo, wtosc]) graph.addModule(m);
    // Pitch already driven — auto-wire must take the next free control input.
    graph.connect({ moduleId: lfo0.id, portId: 'out' }, { moduleId: wtosc.id, portId: 'pitch' });
    const plan = planAutoWire(graph, [lfo.id, wtosc.id]);
    expect(plan).toEqual([
      { from: { moduleId: lfo.id, portId: 'out' }, to: { moduleId: wtosc.id, portId: 'posMod' } },
    ]);
  });

  it('returns empty plan when nothing matches', () => {
    const graph = new Graph(MODULE_DEFS);
    const kb1 = createInstance(MODULE_DEFS.get('keyboard')!, 0, 0);
    const kb2 = createInstance(MODULE_DEFS.get('keyboard')!, 300, 0);
    for (const m of [kb1, kb2]) graph.addModule(m);
    expect(planAutoWire(graph, [kb1.id, kb2.id])).toEqual([]);
  });

  it('wires groups through their poles', () => {
    const graph = new Graph(MODULE_DEFS);
    const keyboard = createInstance(MODULE_DEFS.get('keyboard')!, 0, 0);
    const smpl = createInstance(MODULE_DEFS.get('smpl')!, 310, 0);
    const audioOut = createInstance(MODULE_DEFS.get('audioOut')!, 320, 10);
    for (const m of [keyboard, smpl, audioOut]) graph.addModule(m);
    // Internally wired voice group: smpl.out → audioOut.in stays inside; the
    // group's free poles include smpl.notes (its input side).
    graph.connect({ moduleId: smpl.id, portId: 'out' }, { moduleId: audioOut.id, portId: 'in' });
    const group = graph.createGroup('Voice', [smpl.id, audioOut.id], [], 300, 0);
    const plan = planAutoWire(graph, [keyboard.id], [group.id]);
    expect(plan).toContainEqual({
      from: { moduleId: keyboard.id, portId: 'notes' },
      to: { moduleId: smpl.id, portId: 'notes' },
    });
    for (const p of plan) expect(graph.connect(p.from, p.to).ok).toBe(true);
  });

  it('group-to-group wiring matches free poles by type', () => {
    const graph = new Graph(MODULE_DEFS);
    const lfo = createInstance(MODULE_DEFS.get('lfo')!, 0, 0);
    const vcf = createInstance(MODULE_DEFS.get('vcf')!, 300, 0);
    for (const m of [lfo, vcf]) graph.addModule(m);
    const src = graph.createGroup('Mod', [lfo.id], [], 0, 0);
    const dst = graph.createGroup('Filter', [vcf.id], [], 300, 0);
    const plan = planAutoWire(graph, [], [src.id, dst.id]);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0].from).toEqual({ moduleId: lfo.id, portId: 'out' });
    expect(plan[0].to.moduleId).toBe(vcf.id);
  });
});
