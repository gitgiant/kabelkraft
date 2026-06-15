import { describe, expect, it } from 'vitest';
import { closest, extractJson, parseKkGroup, suggestType } from './aiimport';
import { generateSpecPack } from './aispec';
import { MODULE_DEFS } from './registry';

const valid = JSON.stringify({
  kind: 'kkgroup',
  formatVersion: 1,
  name: 'Test',
  modules: [
    { id: 'a', type: 'smpl', params: { level: 0.5 } },
    { id: 'b', type: 'audioOut' },
  ],
  wires: [{ from: { module: 'a', port: 'out' }, to: { module: 'b', port: 'in' } }],
});

describe('AI patch validation', () => {
  it('accepts a valid patch', () => {
    const r = parseKkGroup(valid, MODULE_DEFS);
    expect(r.ok).toBe(true);
    expect(r.patch!.modules).toHaveLength(2);
    expect(r.patch!.wires).toHaveLength(1);
  });

  it('extracts a json block from a markdown chatbot reply', () => {
    const reply = 'Here is your patch!\n```json\n' + valid + '\n```\nEnjoy!';
    expect(extractJson(reply)).toBe(valid);
    expect(parseKkGroup(reply, MODULE_DEFS).ok).toBe(true);
  });

  it('reports unknown module types with a closest match', () => {
    const r = parseKkGroup(
      JSON.stringify({ modules: [{ id: 'a', type: 'lfoo' }] }),
      MODULE_DEFS,
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('"lfoo" unknown');
    expect(r.errors[0]).toContain('"lfo"');
  });

  it('drops unknown params with a suggestion and clamps out-of-range values', () => {
    const r = parseKkGroup(
      JSON.stringify({
        modules: [{ id: 'a', type: 'smpl', params: { levle: 0.5, level: 99 } }],
      }),
      MODULE_DEFS,
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('levle') && w.includes('level'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('clamped'))).toBe(true);
    expect(r.patch!.modules[0].params.level).toBe(1);
  });

  it('rejects wires with bad ports, wrong direction or type mismatch', () => {
    const make = (wire: object) =>
      parseKkGroup(
        JSON.stringify({
          modules: [
            { id: 'a', type: 'smpl' },
            { id: 'b', type: 'audioOut' },
            { id: 'l', type: 'lfo' },
          ],
          wires: [wire],
        }),
        MODULE_DEFS,
      );
    const badPort = make({ from: { module: 'a', port: 'outt' }, to: { module: 'b', port: 'in' } });
    expect(badPort.ok).toBe(false);
    expect(badPort.errors[0]).toContain('"out"'); // suggestion
    const wrongDir = make({ from: { module: 'b', port: 'in' }, to: { module: 'a', port: 'out' } });
    expect(wrongDir.ok).toBe(false);
    const mismatch = make({ from: { module: 'l', port: 'out' }, to: { module: 'b', port: 'in' } });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors[0]).toContain('type mismatch');
  });

  it('rejects garbage and empty patches readably', () => {
    expect(parseKkGroup('not json at all', MODULE_DEFS).errors[0]).toContain('Not valid JSON');
    expect(parseKkGroup('{}', MODULE_DEFS).errors[0]).toContain('modules');
  });

  it('closest() only suggests plausible matches', () => {
    expect(closest('vcff', MODULE_DEFS.keys())).toBe('vcf');
    expect(closest('zzzzzzzzzz', MODULE_DEFS.keys())).toBeNull();
  });

  it('suggestType falls back to vocabulary aliases (superSaw → osc, drums → smpl)', () => {
    expect(suggestType('superSaw', MODULE_DEFS.keys())).toBe('osc');
    expect(suggestType('drumMachine', MODULE_DEFS.keys())).toBe('smpl');
    expect(suggestType('zzqq', MODULE_DEFS.keys())).toBeNull();
  });
});

describe('AI spec pack', () => {
  it('documents every module, its ports and params', () => {
    const spec = generateSpecPack();
    for (const def of MODULE_DEFS.values()) {
      expect(spec).toContain(`### ${def.type} — ${def.name}`);
      for (const p of def.params) expect(spec).toContain(`\`${p.id}\``);
    }
    expect(spec).toContain('kkgroup');
    expect(spec).toContain('single fan-in');
  });

  it('its own examples validate against the parser', () => {
    const spec = generateSpecPack();
    const blocks = [...spec.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
    // Keep full patches (the face-rules block is a fragment); the first such
    // block is the format template (placeholder wire targets) — skip it.
    const examples = blocks.filter((b) => b.includes('"modules"')).slice(1);
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const ex of examples) {
      const r = parseKkGroup(ex, MODULE_DEFS);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    }
  });

  it('documents the optional face format', () => {
    const spec = generateSpecPack();
    expect(spec).toContain('Optional module face');
    expect(spec).toContain('"kind": "knob"');
  });
});

describe('AI face parsing', () => {
  const withFace = (face: unknown) =>
    JSON.stringify({
      kind: 'kkgroup',
      modules: [
        { id: 'a', type: 'smpl' },
        { id: 'b', type: 'audioOut' },
      ],
      wires: [{ from: { module: 'a', port: 'out' }, to: { module: 'b', port: 'in' } }],
      face,
    });

  it('parses a face and keeps valid bindings', () => {
    const r = parseKkGroup(
      withFace({
        width: 300,
        height: 200,
        elements: [
          { kind: 'label', x: 10, y: 0, text: 'SYNTH' },
          { kind: 'knob', x: 10, y: 24, label: 'Level', module: 'a', param: 'level' },
          { kind: 'meter', x: 10, y: 150, module: 'b' },
        ],
      }),
      MODULE_DEFS,
    );
    expect(r.ok).toBe(true);
    expect(r.patch!.face!.elements).toHaveLength(3);
    const knob = r.patch!.face!.elements.find((e) => e.kind === 'knob')!;
    expect(knob.moduleId).toBe('a');
    expect(knob.paramId).toBe('level');
    // Face is shrunk to its element bounds, not the declared 300×200.
    expect(r.patch!.face!.width).toBeLessThan(300);
    expect(r.patch!.face!.width).toBeGreaterThanOrEqual(106); // widest element: label at x10 + default w96
  });

  it('warns and unbinds a knob whose param is unknown, but still imports', () => {
    const r = parseKkGroup(
      withFace({ elements: [{ kind: 'knob', x: 0, y: 0, module: 'a', param: 'nope' }] }),
      MODULE_DEFS,
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('nope'))).toBe(true);
    expect(r.patch!.face!.elements[0].paramId).toBeUndefined();
  });

  it('drops elements with an unknown kind or an image kind', () => {
    const r = parseKkGroup(
      withFace({
        elements: [
          { kind: 'wobble', x: 0, y: 0 },
          { kind: 'image', x: 0, y: 0 },
          { kind: 'label', x: 0, y: 0, text: 'ok' },
        ],
      }),
      MODULE_DEFS,
    );
    expect(r.ok).toBe(true);
    expect(r.patch!.face!.elements).toHaveLength(1);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves out the face when none is supplied', () => {
    const r = parseKkGroup(withFace(undefined), MODULE_DEFS);
    expect(r.ok).toBe(true);
    expect(r.patch!.face).toBeUndefined();
  });
});
