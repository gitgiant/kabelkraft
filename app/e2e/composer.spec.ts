import { expect, test } from '@playwright/test';

test('composer default song plays track 1; other track outputs stay isolated', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });

  const ids = await page.evaluate(() => {
    const s = window.__kk;
    // Clean slate: only transport + composer + two synths + out.
    for (const m of [...s.graph.modules.values()]) s.removeModule(m.id);
    s.addModule('transport', -200, -400);
    const comp = s.addModule('composer', -500, 0);
    const synth1 = s.addModule('synth', 100, -100);
    const synth2 = s.addModule('synth', 100, 300);
    const out = s.addModule('audioOut', 600, 100);
    s.connect({ moduleId: comp.id, portId: 'out1' }, { moduleId: synth1.id, portId: 'notes' });
    s.connect({ moduleId: comp.id, portId: 'out2' }, { moduleId: synth2.id, portId: 'notes' });
    s.connect({ moduleId: synth1.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
    s.connect({ moduleId: synth2.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
    return { comp: comp.id, synth1: synth1.id, synth2: synth2.id };
  });

  await page.locator('.transport button[title="Play"]').click();

  // Default data: pattern A track 1 has notes, song slots 0–1 play A.
  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, ids.synth1), { timeout: 5000 })
    .toBeGreaterThan(0.01);

  // Track 2 is empty — out2 must carry nothing (port-aware routing).
  const synth2Peak = await page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, ids.synth2);
  expect(synth2Peak).toBeLessThan(0.001);
});

test('composer pattern + song edits route the right pattern to the right track', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });

  const ids = await page.evaluate(() => {
    const s = window.__kk;
    for (const m of [...s.graph.modules.values()]) s.removeModule(m.id);
    s.addModule('transport', -200, -400);
    const comp = s.addModule('composer', -500, 0);
    const synth = s.addModule('synth', 100, 0);
    const out = s.addModule('audioOut', 600, 0);
    s.connect({ moduleId: comp.id, portId: 'out3' }, { moduleId: synth.id, portId: 'notes' });
    s.connect({ moduleId: synth.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });

    // Author pattern B (index 1), track 3: notes on every quarter.
    const patterns = comp.data!.patterns as Array<Array<Array<{ on: boolean; pitch: number }>>>;
    for (const i of [0, 4, 8, 12]) patterns[1][2][i] = { on: true, pitch: 64 };
    s.setModuleData(comp.id, 'patterns', [...patterns]);
    // Song: every slot plays B so the playhead is always inside it.
    s.setModuleData(comp.id, 'song', Array.from({ length: 16 }, () => 1));
    return { synth: synth.id };
  });

  await page.locator('.transport button[title="Play"]').click();
  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, ids.synth), { timeout: 5000 })
    .toBeGreaterThan(0.01);

  // Stop releases composer voices (no stuck notes => meter decays to ~0).
  await page.locator('.transport button[title="Stop"]').click();
  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, ids.synth), { timeout: 5000 })
    .toBeLessThan(0.005);
});
