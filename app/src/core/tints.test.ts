import { describe, expect, it } from 'vitest';
import { TintEngine } from './tints';
import { rgbIntToHsl } from './color';
import type { Graph } from './graph';

/**
 * Minimal graph stub exposing only what TintEngine reads: wire/group/module
 * maps plus groupOfModule/parentGroup ancestor lookups. Lets the engine be
 * exercised with plain data — no AppState, AudioContext, or Pixi.
 */
function fakeGraph() {
  const wires = new Map<string, any>();
  const groups = new Map<string, any>();
  const modules = new Map<string, any>();
  let n = 0;
  const g = {
    wires,
    groups,
    modules,
    groupOfModule: (id: string) => [...groups.values()].find((gr) => gr.moduleIds?.includes(id)),
    parentGroup: (id: string) => [...groups.values()].find((gr) => gr.groupIds?.includes(id)),
    addModule(id: string) {
      modules.set(id, { id });
    },
    /** A visual wire from `src` into `dest`'s tint endpoint. */
    addTintWire(src: string, dest: string) {
      wires.set(`w${n++}`, { type: 'visual', from: { moduleId: src }, to: { moduleId: dest, portId: 'tint' } });
    },
    addGroup(id: string, opts: { moduleIds?: string[]; groupIds?: string[]; face?: any } = {}) {
      groups.set(id, { id, moduleIds: opts.moduleIds ?? [], groupIds: opts.groupIds ?? [], face: opts.face });
    },
  };
  return g;
}

function engineOver(g: ReturnType<typeof fakeGraph>) {
  return new TintEngine(() => g as unknown as Graph);
}

describe('TintEngine', () => {
  it('sourceIds collects tint-wire sources and face-element bindings', () => {
    const g = fakeGraph();
    g.addTintWire('vis1', 'mod1');
    g.addGroup('g1', { face: { elements: [{ tintSourceId: 'vis2' }, {}] } });
    const t = engineOver(g);
    expect(t.sourceIds()).toEqual(new Set(['vis1', 'vis2']));
  });

  it('sourceFor: own tint wire wins; else nearest wired ancestor (inside-out)', () => {
    const g = fakeGraph();
    g.addModule('m1');
    g.addGroup('inner', { moduleIds: ['m1'] });
    g.addGroup('outer', { groupIds: ['inner'] });
    const t = engineOver(g);

    // No wire anywhere → no source.
    expect(t.sourceFor('m1')).toBeNull();

    // Wire into the OUTER group → m1 resolves to it via ancestor walk.
    g.addTintWire('visOuter', 'outer');
    t.invalidate();
    expect(t.sourceFor('m1')).toBe('visOuter');

    // A nearer wire (inner group) takes precedence.
    g.addTintWire('visInner', 'inner');
    t.invalidate();
    expect(t.sourceFor('m1')).toBe('visInner');

    // The module's own tint port beats every ancestor.
    g.addTintWire('visOwn', 'm1');
    t.invalidate();
    expect(t.sourceFor('m1')).toBe('visOwn');
  });

  it('sample is gated by wanted() — a non-source id is ignored', () => {
    const g = fakeGraph();
    g.addModule('vis1');
    g.addTintWire('vis1', 'm1');
    const t = engineOver(g);
    t.sample('strangerId', 0x00ff00); // not a source
    t.tick(1000);
    expect(t.values['strangerId']).toBeUndefined();
  });

  it('sample clamps a near-black frame up to the readable luminance floor', () => {
    const g = fakeGraph();
    g.addModule('vis1');
    g.addTintWire('vis1', 'm1');
    const t = engineOver(g);

    t.sample('vis1', 0x000000); // pure black, luminance 0
    t.tick(10_000); // settle
    expect(rgbIntToHsl(t.values['vis1']).l).toBeGreaterThanOrEqual(0.21);

    t.sample('vis1', 0xffffff); // bright passes through unchanged
    t.tick(10_000);
    expect(t.values['vis1']).toBe(0xffffff);
  });

  it('tick eases toward the target, settling after enough time', () => {
    const g = fakeGraph();
    g.addModule('vis1');
    g.addTintWire('vis1', 'm1');
    const t = engineOver(g);

    t.sample('vis1', 0x808080);
    t.tick(16); // first tick: undefined → snaps to target
    expect(t.values['vis1']).toBe(0x808080);

    t.sample('vis1', 0xffffff);
    t.tick(16); // one small step: between grey and white, not there yet
    const mid = t.values['vis1'] & 0xff;
    expect(mid).toBeGreaterThan(0x80);
    expect(mid).toBeLessThan(0xff);

    t.tick(10_000); // long step: settled
    expect(t.values['vis1']).toBe(0xffffff);
  });

  it('tick evicts a tint whose module has been removed', () => {
    const g = fakeGraph();
    g.addModule('vis1');
    g.addTintWire('vis1', 'm1');
    const t = engineOver(g);
    t.sample('vis1', 0x808080);
    t.tick(16);
    expect(t.values['vis1']).toBe(0x808080);

    g.modules.delete('vis1'); // source module gone
    t.tick(16);
    expect(t.values['vis1']).toBeUndefined();
  });

  it('tintFor/tintForGroup resolve source then look up the eased value', () => {
    const g = fakeGraph();
    g.addModule('vis1');
    g.addModule('visG');
    g.addModule('m1');
    g.addTintWire('vis1', 'm1');
    g.addGroup('g1', { moduleIds: ['m1'] });
    g.addTintWire('visG', 'g1');
    const t = engineOver(g);
    t.sample('vis1', 0x80a0c0); // both above the 0.22 luminance floor → pass through
    t.sample('visG', 0xc0a080);
    t.tick(10_000);

    expect(t.tintFor('m1')).toBe(0x80a0c0); // own wire wins
    expect(t.tintForGroup('g1')).toBe(0xc0a080);
    expect(t.tintFor('unknown')).toBeNull();
  });
});
