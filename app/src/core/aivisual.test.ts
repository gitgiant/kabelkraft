import { describe, expect, it } from 'vitest';
import { generateVisualSpecPack, parseKkVis } from './aivisual';
import { VIS_NODE_DEFS } from '../visual/registry';

function vis(doc: Record<string, unknown>): string {
  return '```json\n' + JSON.stringify({ kind: 'kkvis', ...doc }) + '\n```';
}

describe('parseKkVis', () => {
  it('accepts a valid graph and auto-lays-out omitted positions', () => {
    const r = parseKkVis(
      vis({
        name: 'Test',
        nodes: [
          { id: 's', type: 'spectrum', params: { gain: 2 } },
          { id: 'b', type: 'bloom' },
          { id: 'o', type: 'output' },
        ],
        wires: [
          { from: { node: 's', port: 'out' }, to: { node: 'b', port: 'in' } },
          { from: { node: 'b', port: 'out' }, to: { node: 'o', port: 'in' } },
        ],
        note: 'tip',
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.name).toBe('Test');
    expect(r.note).toBe('tip');
    const g = r.graph!;
    expect(g.nodes.map((n) => n.type)).toEqual(['spectrum', 'bloom', 'output']);
    // Auto-layout: downstream nodes sit further right.
    const x = Object.fromEntries(g.nodes.map((n) => [n.id, n.x]));
    expect(x.s).toBeLessThan(x.b);
    expect(x.b).toBeLessThan(x.o);
  });

  it('suggests the closest type for unknown nodes', () => {
    const r = parseKkVis(
      vis({
        nodes: [{ id: 'a', type: 'spectrun' }, { id: 'o', type: 'output' }],
        wires: [{ from: { node: 'a', port: 'out' }, to: { node: 'o', port: 'in' } }],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('spectrum');
  });

  it('clamps out-of-range params and drops unknown ones with warnings', () => {
    const r = parseKkVis(
      vis({
        nodes: [
          { id: 's', type: 'spectrum', params: { gain: 99, sparkle: 1 } },
          { id: 'o', type: 'output' },
        ],
        wires: [{ from: { node: 's', port: 'out' }, to: { node: 'o', port: 'in' } }],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes[0].params.gain).toBe(4);
    expect(r.warnings.some((w) => w.includes('clamped'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('sparkle'))).toBe(true);
  });

  it('rejects cycles, missing output, unfed output and type mismatches', () => {
    const cycle = parseKkVis(
      vis({
        nodes: [
          { id: 'a', type: 'blur' },
          { id: 'b', type: 'warp' },
          { id: 'o', type: 'output' },
        ],
        wires: [
          { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } },
          { from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'in' } },
          { from: { node: 'b', port: 'out' }, to: { node: 'o', port: 'in' } },
        ],
      }),
    );
    expect(cycle.ok).toBe(false);
    expect(cycle.errors.join(' ')).toContain('cycle');

    const noOut = parseKkVis(vis({ nodes: [{ id: 's', type: 'spectrum' }], wires: [] }));
    expect(noOut.ok).toBe(false);
    expect(noOut.errors.join(' ')).toContain('output');

    const unfed = parseKkVis(
      vis({ nodes: [{ id: 's', type: 'spectrum' }, { id: 'o', type: 'output' }], wires: [] }),
    );
    expect(unfed.ok).toBe(false);
    expect(unfed.errors.join(' ')).toContain('nothing wired');

    const mismatch = parseKkVis(
      vis({
        nodes: [
          { id: 'f', type: 'features' },
          { id: 'o', type: 'output' },
          { id: 's', type: 'spectrum' },
        ],
        wires: [
          { from: { node: 'f', port: 'bass' }, to: { node: 'o', port: 'in' } },
          { from: { node: 's', port: 'out' }, to: { node: 'o', port: 'in' } },
        ],
      }),
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.join(' ')).toContain('type mismatch');
  });

  it('drops extra wires into a taken input with a warning', () => {
    const r = parseKkVis(
      vis({
        nodes: [
          { id: 'a', type: 'spectrum' },
          { id: 'b', type: 'scope' },
          { id: 'o', type: 'output' },
        ],
        wires: [
          { from: { node: 'a', port: 'out' }, to: { node: 'o', port: 'in' } },
          { from: { node: 'b', port: 'out' }, to: { node: 'o', port: 'in' } },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.graph!.wires.length).toBe(1);
    expect(r.warnings.some((w) => w.includes('blend'))).toBe(true);
  });

  it('keeps textlayer fallback text from data', () => {
    const r = parseKkVis(
      vis({
        nodes: [
          { id: 't', type: 'textlayer', data: { text: 'DROP' } },
          { id: 'o', type: 'output' },
        ],
        wires: [{ from: { node: 't', port: 'out' }, to: { node: 'o', port: 'in' } }],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes[0].data?.text).toBe('DROP');
  });
});

describe('generateVisualSpecPack', () => {
  it('contains every node type and the format rules', () => {
    const spec = generateVisualSpecPack();
    for (const type of VIS_NODE_DEFS.keys()) expect(spec).toContain(`### ${type}`);
    expect(spec).toContain('"kind": "kkvis"');
    expect(spec).toContain('Exactly ONE');
  });
});
