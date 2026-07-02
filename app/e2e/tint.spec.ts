import { expect, test } from '@playwright/test';
import { boot, captureErrors, clearPatch, settleFrames } from './util';

/** Tint system: group intrinsic tint poles, module tint ports, derived frame colors. */

test('group tint pole accepts visual wires with single fan-in; types enforced', async ({ page }) => {
  await boot(page);
  await clearPatch(page);

  const result = await page.evaluate(() => {
    const s = window.__kk;
    const visA = s.addModule('visualizer', -400, -200);
    const visB = s.addModule('visualizer', -400, 300);
    const knob = s.addModule('knob', 100, 0);
    const lfo = s.addModule('lfo', 100, 300);
    s.selectedModuleIds.add(knob.id);
    s.selectedModuleIds.add(lfo.id);
    const groupId = s.groupSelection()!;

    const poles = s.graph.groupPoles(groupId);
    const tintPole = poles.find((p) => p.portId === 'tint' && p.moduleId === groupId);

    const a = s.connect({ moduleId: visA.id, portId: 'vout' }, { moduleId: groupId, portId: 'tint' });
    // Second visual wire into the pole replaces the first (single fan-in).
    const b = s.connect({ moduleId: visB.id, portId: 'vout' }, { moduleId: groupId, portId: 'tint' });
    const intoTint = [...s.graph.wires.values()].filter(
      (w) => w.to.moduleId === groupId && w.to.portId === 'tint',
    );
    // A control output cannot feed the visual tint pole.
    const bad = s.connect({ moduleId: lfo.id, portId: 'out' }, { moduleId: groupId, portId: 'tint' });

    // Nearest-source resolution: members inherit the group's tint source.
    const knobSrc = s.tints.sourceFor(knob.id);

    return {
      tintPole: !!tintPole && tintPole.type === 'visual' && tintPole.direction === 'in',
      intrinsic: tintPole?.intrinsic === true,
      aOk: a.ok,
      bOk: b.ok,
      detached: b.ok ? b.detached?.from.moduleId : null,
      intoTint: intoTint.length,
      badOk: bad.ok,
      knobSrc,
      visB: visB.id,
      groupId,
    };
  });

  expect(result.tintPole).toBe(true);
  expect(result.intrinsic).toBe(true);
  expect(result.aOk).toBe(true);
  expect(result.bOk).toBe(true);
  expect(result.intoTint).toBe(1);
  expect(result.badOk).toBe(false);
  expect(result.knobSrc).toBe(result.visB);

  // Deleting the group removes the wire ending on its pole.
  const after = await page.evaluate((r) => {
    const s = window.__kk;
    s.clearSelection();
    s.selectedGroupIds.add(r.groupId);
    s.deleteSelection();
    return [...s.graph.wires.values()].filter((w) => w.to.moduleId === r.groupId).length;
  }, result);
  expect(after).toBe(0);
});

test('tint survives save/load; nested groups resolve nearest source', async ({ page }) => {
  await boot(page);
  await clearPatch(page);

  const result = await page.evaluate(() => {
    const s = window.__kk;
    const vis = s.addModule('visualizer', -400, 0);
    const knobA = s.addModule('knob', 100, 0);
    const knobB = s.addModule('knob', 100, 300);
    s.selectedModuleIds.add(knobA.id);
    s.selectedModuleIds.add(knobB.id);
    const inner = s.groupSelection()!;
    s.clearSelection();
    s.selectedGroupIds.add(inner);
    s.selectedModuleIds.add(vis.id);
    const outer = s.groupSelection()!;
    const w = s.connect({ moduleId: vis.id, portId: 'vout' }, { moduleId: outer, portId: 'tint' });
    return {
      wired: w.ok,
      vis: vis.id,
      knobA: knobA.id,
      inner,
      outer,
      // Members of the inner (unwired) group inherit the outer group's source.
      srcThroughNesting: s.tints.sourceFor(knobA.id),
      json: s.serialize(),
    };
  });
  expect(result.wired).toBe(true);
  expect(result.srcThroughNesting).toBe(result.vis);

  // Round-trip: the group-endpoint wire must survive deserialization.
  const reloaded = await page.evaluate((r) => {
    const s = window.__kk;
    s.loadProject(r.json);
    const intoTint = [...s.graph.wires.values()].filter(
      (w) => w.to.moduleId === r.outer && w.to.portId === 'tint',
    );
    return { intoTint: intoTint.length, src: s.tints.sourceFor(r.knobA) };
  }, result);
  expect(reloaded.intoTint).toBe(1);
  expect(reloaded.src).toBe(result.vis);
});

test('module tint ports exist on containers; derived color flows when GPU renders', async ({ page }) => {
  const errors = captureErrors(page);
  await boot(page);
  await clearPatch(page);

  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const vis = s.addModule('visualizer', -400, 0);
    const comp = s.addModule('composer', 100, 0);
    const wire = s.connect(
      { moduleId: vis.id, portId: 'vout' },
      { moduleId: comp.id, portId: 'tint' },
    );
    return { vis: vis.id, comp: comp.id, wired: wire.ok };
  });
  expect(ids.wired).toBe(true);

  const gpu = await page.evaluate(() => 'gpu' in navigator);
  if (gpu) {
    // The visualizer tile renders on screen → the sampler derives a color.
    await expect
      .poll(() => page.evaluate((i) => window.__kk.tints.values[i.vis], ids), { timeout: 10000 })
      .toBeGreaterThanOrEqual(0);
    // …and the composer resolves it as its tint.
    await expect
      .poll(() => page.evaluate((i) => window.__kk.tints.tintFor(i.comp), ids), { timeout: 5000 })
      .toBeGreaterThanOrEqual(0);
  }
  await settleFrames(page, 5);
  expect(errors).toEqual([]);
});
