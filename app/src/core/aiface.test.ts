import { describe, expect, it } from 'vitest';
import { generateFaceSpecPack, parseKkFace } from './aiface';
import { Graph } from './graph';
import { createInstance } from './module';
import { MODULE_DEFS } from './registry';

function setup() {
  const graph = new Graph(MODULE_DEFS);
  const vcf = createInstance(MODULE_DEFS.get('vcf')!, 0, 0);
  const out = createInstance(MODULE_DEFS.get('audioOut')!, 300, 0);
  const lfo = createInstance(MODULE_DEFS.get('lfo')!, 600, 0); // outside the group
  for (const m of [vcf, out, lfo]) graph.addModule(m);
  const group = graph.createGroup('Filter Box', [vcf.id, out.id], [], 0, 0);
  return { graph, vcf, out, lfo, group };
}

describe('AI face generation (.kkface)', () => {
  it('spec pack lists the group modules with real ids, params, and meter targets', () => {
    const { graph, vcf, out, lfo, group } = setup();
    const spec = generateFaceSpecPack(graph, group.id);
    expect(spec).toContain('kkface');
    expect(spec).toContain('"kind": "knob"'); // shared face element rules ride along
    expect(spec).toContain('Filter Box');
    expect(spec).toContain(`id "${vcf.id}"`);
    expect(spec).toContain('cutoff');
    expect(spec).toContain(`"${out.id}"`); // meter target
    expect(spec).not.toContain(`id "${lfo.id}"`); // not a member
  });

  it('parses a valid reply, binding against live instance ids', () => {
    const { graph, vcf, group } = setup();
    const reply = JSON.stringify({
      kind: 'kkface',
      width: 300,
      height: 180,
      elements: [
        { kind: 'label', x: 10, y: 4, text: 'FILTER' },
        { kind: 'knob', x: 10, y: 30, label: 'Cutoff', module: vcf.id, param: 'cutoff' },
      ],
    });
    const r = parseKkFace(reply, graph, group.id);
    expect(r.ok).toBe(true);
    expect(r.face!.elements).toHaveLength(2);
    expect(r.face!.elements[1].moduleId).toBe(vcf.id);
    expect(r.face!.elements[1].paramId).toBe('cutoff');
  });

  it('accepts a reply wrapped as { "face": {...} } and markdown fences', () => {
    const { graph, vcf, group } = setup();
    const reply =
      'Here you go:\n```json\n' +
      JSON.stringify({ face: { elements: [{ kind: 'knob', module: vcf.id, param: 'res' }] } }) +
      '\n```';
    const r = parseKkFace(reply, graph, group.id);
    expect(r.ok).toBe(true);
    expect(r.face!.elements[0].paramId).toBe('res');
  });

  it('drops bindings to modules outside the group with a warning', () => {
    const { graph, lfo, group } = setup();
    const reply = JSON.stringify({
      kind: 'kkface',
      elements: [{ kind: 'knob', x: 0, y: 0, module: lfo.id, param: 'rate' }],
    });
    const r = parseKkFace(reply, graph, group.id);
    expect(r.ok).toBe(true);
    expect(r.face!.elements[0].moduleId).toBeUndefined();
    expect(r.warnings.some((w) => w.includes(lfo.id))).toBe(true);
  });

  it('errors on no usable elements and on invalid JSON', () => {
    const { graph, group } = setup();
    expect(parseKkFace('{"kind":"kkface","elements":[]}', graph, group.id).ok).toBe(false);
    expect(parseKkFace('not json at all', graph, group.id).ok).toBe(false);
  });
});
