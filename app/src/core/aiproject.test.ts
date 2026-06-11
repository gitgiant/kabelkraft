import { describe, expect, it } from 'vitest';
import { generateProjectSpecPack, parseKkProject } from './aiproject';
import { MODULE_DEFS } from './registry';

const validProject = JSON.stringify({
  kind: 'kkproject',
  formatVersion: 1,
  name: 'Test Song',
  tempo: 96,
  modules: [
    {
      id: 'comp',
      type: 'composer',
      data: {
        length: 8,
        notes: [
          { start: 0, length: 1, pitch: 48, vel: 0.9 },
          { start: 4, length: 1, pitch: 200, vel: 5 }, // out of range → sanitized
        ],
      },
    },
    { id: 'v', type: 'voice', params: { voices: 1 } },
    { id: 'o', type: 'osc', params: { wave: 3 } },
    { id: 'mix', type: 'mixer' },
    { id: 'out', type: 'audioOut' },
  ],
  wires: [
    { from: { module: 'comp', port: 'notes' }, to: { module: 'v', port: 'notes' } },
    { from: { module: 'v', port: 'pitch' }, to: { module: 'o', port: 'pitch' } },
    { from: { module: 'o', port: 'out' }, to: { module: 'mix', port: 'in1' } },
    { from: { module: 'mix', port: 'out' }, to: { module: 'out', port: 'in' } },
  ],
  groups: [
    { id: 'bass', name: 'Bass', modules: ['comp', 'v', 'o'], groups: [] },
    { id: 'master', name: 'Master', modules: ['mix', 'out'], groups: ['bass'] },
  ],
});

describe('AI project validation', () => {
  it('accepts a valid project with nested groups and tempo', () => {
    const r = parseKkProject(validProject, MODULE_DEFS);
    expect(r.ok).toBe(true);
    const p = r.project!;
    expect(p.name).toBe('Test Song');
    expect(p.tempo).toBe(96);
    expect(p.modules).toHaveLength(5);
    expect(p.wires).toHaveLength(4);
    expect(p.groups).toHaveLength(2);
    const master = p.groups.find((g) => g.id === 'master')!;
    expect(master.groupIds).toEqual(['bass']);
  });

  it('sanitizes embedded composer clips (pitch/velocity clamped)', () => {
    const r = parseKkProject(validProject, MODULE_DEFS);
    const comp = r.project!.modules.find((m) => m.id === 'comp')!;
    const notes = comp.data!.notes as Array<{ pitch: number; vel: number }>;
    expect(notes).toHaveLength(2);
    expect(notes[1].pitch).toBe(127);
    expect(notes[1].vel).toBe(1);
  });

  it('clamps an out-of-range tempo with a warning and defaults a missing one', () => {
    const fast = JSON.parse(validProject);
    fast.tempo = 999;
    let r = parseKkProject(JSON.stringify(fast), MODULE_DEFS);
    expect(r.project!.tempo).toBe(300);
    expect(r.warnings.some((w) => w.includes('Tempo'))).toBe(true);

    delete fast.tempo;
    r = parseKkProject(JSON.stringify(fast), MODULE_DEFS);
    expect(r.project!.tempo).toBe(120);
  });

  it('drops bad group references with warnings', () => {
    const doc = JSON.parse(validProject);
    doc.groups = [
      { id: 'g1', name: 'A', modules: ['comp', 'ghost'], groups: ['nope'] },
      { id: 'g2', name: 'B', modules: ['comp'], groups: [] }, // comp already in g1
    ];
    const r = parseKkProject(JSON.stringify(doc), MODULE_DEFS);
    expect(r.ok).toBe(true);
    expect(r.project!.groups[0].moduleIds).toEqual(['comp']);
    expect(r.project!.groups[0].groupIds).toEqual([]);
    expect(r.project!.groups[1].moduleIds).toEqual([]);
    expect(r.warnings.some((w) => w.includes('ghost'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('nope'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('kept in "g1"'))).toBe(true);
  });

  it('breaks group nesting cycles', () => {
    const doc = JSON.parse(validProject);
    doc.groups = [
      { id: 'a', name: 'A', modules: [], groups: ['b'] },
      { id: 'b', name: 'B', modules: [], groups: ['a'] },
    ];
    const r = parseKkProject(JSON.stringify(doc), MODULE_DEFS);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('cycle'))).toBe(true);
    const childCount = r.project!.groups.reduce((s, g) => s + g.groupIds.length, 0);
    expect(childCount).toBeLessThan(2); // at least one parent link dropped
  });

  it('rejects structural errors from the shared module/wire validator', () => {
    const r = parseKkProject(
      JSON.stringify({ kind: 'kkproject', modules: [{ id: 'a', type: 'superSaw' }] }),
      MODULE_DEFS,
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('superSaw');
  });

  it('extracts a json block from a markdown chatbot reply', () => {
    const reply = 'Sure! Here is your song:\n```json\n' + validProject + '\n```\nEnjoy!';
    expect(parseKkProject(reply, MODULE_DEFS).ok).toBe(true);
  });

  it('spec pack covers project format, nesting, MIDI fields and the catalog', () => {
    const spec = generateProjectSpecPack();
    expect(spec).toContain('kkproject');
    expect(spec).toContain('tempo');
    expect(spec).toContain('Groups (encapsulation)');
    expect(spec).toContain('Composer clips');
    expect(spec).toContain('## Module catalog');
    expect(spec).toContain('audioOut');
    // Starter patches are a UI affordance, not modules — never in the spec.
    expect(spec).not.toContain('Init Poly Synth');
  });
});
