import { expect, test } from '@playwright/test';

/** Color system: Color Gen module, color wires, live UI tints (PRD: dynamic colors). */

test('color gen streams changing colors and tints a wired knob', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });

  const ids = await page.evaluate(() => {
    const s = window.__kk;
    for (const g of [...s.graph.groups.keys()]) s.ungroup(g);
    for (const m of [...s.graph.modules.values()]) s.removeModule(m.id);
    const gen = s.addModule('colorgen', -300, 0);
    const knob = s.addModule('knob', 100, 0);
    s.setParam(gen.id, 'mode', 0); // rainbow — changes with no input wired
    s.setParam(gen.id, 'rate', 4);
    const wire = s.connect(
      { moduleId: gen.id, portId: 'out' },
      { moduleId: knob.id, portId: 'color' },
    );
    return { gen: gen.id, knob: knob.id, wired: wire.ok };
  });
  expect(ids.wired).toBe(true);

  // The status stream carries a color for the generator…
  await expect
    .poll(() => page.evaluate((i) => window.__kk.colorValues[i.gen], ids), { timeout: 5000 })
    .toBeGreaterThanOrEqual(0);

  // …and rainbow mode keeps it moving.
  const first = await page.evaluate((i) => window.__kk.colorValues[i.gen], ids);
  await expect
    .poll(() => page.evaluate((i) => window.__kk.colorValues[i.gen], ids), { timeout: 5000 })
    .not.toBe(first);

  expect(errors).toEqual([]);
});

test('color wires are single fan-in; mismatched types rejected', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    const s = window.__kk;
    for (const g of [...s.graph.groups.keys()]) s.ungroup(g);
    for (const m of [...s.graph.modules.values()]) s.removeModule(m.id);
    const genA = s.addModule('colorgen', -300, -200);
    const genB = s.addModule('colorgen', -300, 200);
    const knob = s.addModule('knob', 100, 0);
    const lfo = s.addModule('lfo', -300, 500);

    const a = s.connect({ moduleId: genA.id, portId: 'out' }, { moduleId: knob.id, portId: 'color' });
    // Second color wire into the same input replaces the first (single fan-in).
    const b = s.connect({ moduleId: genB.id, portId: 'out' }, { moduleId: knob.id, portId: 'color' });
    const intoColor = [...s.graph.wires.values()].filter(
      (w) => w.to.moduleId === knob.id && w.to.portId === 'color',
    );
    // Control output cannot feed a color input.
    const bad = s.connect({ moduleId: lfo.id, portId: 'out' }, { moduleId: knob.id, portId: 'color' });
    return {
      aOk: a.ok,
      bOk: b.ok,
      fanIn: intoColor.length,
      from: intoColor[0]?.from.moduleId,
      genB: genB.id,
      badOk: bad.ok,
    };
  });

  expect(result.aOk).toBe(true);
  expect(result.bOk).toBe(true);
  expect(result.fanIn).toBe(1);
  expect(result.from).toBe(result.genB);
  expect(result.badOk).toBe(false);
});
