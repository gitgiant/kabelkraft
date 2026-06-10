import { describe, expect, it } from 'vitest';
import {
  bindableParams,
  defaultFace,
  exportKkmod,
  importKkmod,
  newFaceElement,
  pruneFaceBindings,
  snapTo,
  type FaceSpec,
} from './face';
import { Graph } from './graph';
import { createInstance } from './module';
import { MODULE_DEFS } from './registry';

function makeGraph() {
  const graph = new Graph(MODULE_DEFS);
  const synth = createInstance(MODULE_DEFS.get('synth')!, 0, 0);
  const lfo = createInstance(MODULE_DEFS.get('lfo')!, 200, 0);
  graph.addModule(synth);
  graph.addModule(lfo);
  graph.connect({ moduleId: lfo.id, portId: 'out' }, { moduleId: synth.id, portId: 'pitchMod' });
  const group = graph.createGroup('Lead', [synth.id, lfo.id], [], 0, 0);
  return { graph, synth, lfo, group };
}

describe('face model', () => {
  it('snapTo respects the snap flag and grid', () => {
    expect(snapTo(23, 10, true)).toBe(20);
    expect(snapTo(27, 10, true)).toBe(30);
    expect(snapTo(23.4, 10, false)).toBe(23);
  });

  it('newFaceElement allocates unique ids', () => {
    const face = defaultFace();
    const a = newFaceElement(face, 'knob', 0, 0);
    face.elements.push(a);
    const b = newFaceElement(face, 'slider', 0, 0);
    expect(b.id).not.toBe(a.id);
  });

  it('bindableParams covers nested groups', () => {
    const { graph, synth, lfo, group } = makeGraph();
    const inner = createInstance(MODULE_DEFS.get('vcf')!, 0, 0);
    graph.addModule(inner);
    const child = graph.createGroup('Child', [inner.id], [], 0, 0);
    group.groupIds.push(child.id);

    const targets = bindableParams(graph, group.id);
    expect(targets.some((t) => t.moduleId === synth.id && t.paramId === 'cutoff')).toBe(true);
    expect(targets.some((t) => t.moduleId === lfo.id && t.paramId === 'rate')).toBe(true);
    expect(targets.some((t) => t.moduleId === inner.id && t.paramId === 'cutoff')).toBe(true);
  });

  it('pruneFaceBindings drops dead targets, keeps live ones', () => {
    const { graph, synth, group } = makeGraph();
    const face = defaultFace();
    face.elements.push(
      { ...newFaceElement(face, 'knob', 0, 0), moduleId: synth.id, paramId: 'cutoff' },
      { ...newFaceElement(face, 'knob', 0, 0), id: 'e2', moduleId: 'ghost', paramId: 'level' },
      { ...newFaceElement(face, 'knob', 0, 0), id: 'e3', moduleId: synth.id, paramId: 'nope' },
    );
    pruneFaceBindings(graph, group.id, face);
    expect(face.elements[0].moduleId).toBe(synth.id);
    expect(face.elements[1].moduleId).toBeUndefined();
    expect(face.elements[2].moduleId).toBeUndefined();
  });
});

describe('kkmod export/import', () => {
  it('round-trips a faced group with fresh, remapped ids', () => {
    const { graph, synth, lfo, group } = makeGraph();
    const face: FaceSpec = defaultFace();
    face.bgAssetId = 'fa1';
    face.elements.push({
      ...newFaceElement(face, 'knob', 10, 10),
      moduleId: synth.id,
      paramId: 'cutoff',
      label: 'Cutoff',
    });
    group.face = face;
    graph.modules.get(synth.id)!.params.cutoff = 1234;

    const assets = new Map([['fa1', 'data:image/png;base64,AAAA']]);
    const json = exportKkmod(graph, group.id, assets);
    const imported = importKkmod(json, MODULE_DEFS);

    expect(imported.warnings).toEqual([]);
    expect(imported.modules).toHaveLength(2);
    // Fresh ids — none may collide with the source graph.
    for (const m of imported.modules) expect(graph.modules.has(m.id)).toBe(false);
    expect(imported.groups).toHaveLength(1);
    const root = imported.groups.find((g) => g.id === imported.rootGroupId)!;
    expect(root.face).toBeDefined();
    expect(root.collapsed).toBe(true);
    expect(root.face!.bgAssetId).toBe('fa1');
    expect(imported.assets.fa1).toContain('base64');

    // Binding follows the synth's new id, params survive.
    const newSynth = imported.modules.find((m) => m.type === 'synth')!;
    expect(root.face!.elements[0].moduleId).toBe(newSynth.id);
    expect(newSynth.params.cutoff).toBe(1234);
    expect(root.moduleIds).toContain(newSynth.id);

    // Internal wire preserved (lfo → synth).
    const newLfo = imported.modules.find((m) => m.type === 'lfo')!;
    expect(imported.wires).toEqual([
      {
        from: { moduleId: newLfo.id, portId: 'out' },
        to: { moduleId: newSynth.id, portId: 'pitchMod' },
      },
    ]);
  });

  it('keeps nested group structure', () => {
    const { graph, group } = makeGraph();
    const inner = createInstance(MODULE_DEFS.get('vca')!, 0, 0);
    graph.addModule(inner);
    const child = graph.createGroup('Child', [inner.id], [], 0, 0);
    child.face = defaultFace();
    group.groupIds.push(child.id);

    const imported = importKkmod(exportKkmod(graph, group.id, new Map()), MODULE_DEFS);
    expect(imported.groups).toHaveLength(2);
    const root = imported.groups.find((g) => g.id === imported.rootGroupId)!;
    expect(root.groupIds).toHaveLength(1);
    const newChild = imported.groups.find((g) => g.id === root.groupIds[0])!;
    expect(newChild.face).toBeDefined();
    expect(newChild.moduleIds).toHaveLength(1);
  });

  it('rejects non-kkmod json and drops unknown types with a warning', () => {
    expect(() => importKkmod('{"kind":"other"}', MODULE_DEFS)).toThrow(/Not a .kkmod/);

    const { graph, group } = makeGraph();
    const json = JSON.parse(exportKkmod(graph, group.id, new Map()));
    json.modules[0].type = 'flux-capacitor';
    const imported = importKkmod(JSON.stringify(json), MODULE_DEFS);
    expect(imported.modules).toHaveLength(1);
    expect(imported.warnings.some((w) => w.includes('flux-capacitor'))).toBe(true);
  });
});
