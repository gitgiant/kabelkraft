import { expect, test, type Page } from '@playwright/test';

/**
 * Module face designer (PRD §6 macro controls as a design framework):
 * editor overlay, faced collapsed tiles, expand/shrink, .kkmod round-trip.
 */

async function start(page: Page): Promise<{ synth: string; lfo: string }> {
  await page.goto('/');
  await page.waitForTimeout(400); // starter patch mounts
  return page.evaluate(() => {
    const mods = [...window.__kk.graph.modules.values()];
    return {
      synth: mods.find((m) => m.type === 'synth')!.id,
      lfo: mods.find((m) => m.type === 'lfo')!.id,
    };
  });
}

/** Group synth+lfo and return the group id (selected afterwards). */
async function makeGroup(page: Page, ids: { synth: string; lfo: string }): Promise<string> {
  return page.evaluate((i) => {
    const s = window.__kk;
    s.clearSelection();
    s.addToSelection({ moduleId: i.synth });
    s.addToSelection({ moduleId: i.lfo });
    return s.groupSelection()!;
  }, ids);
}

test('design a face in the editor; the collapsed tile knob drives the inner param', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  const ids = await start(page);
  const groupId = await makeGroup(page, ids);

  // Toolbar → editor.
  await page.locator('button.edit-face').click();
  await expect(page.locator('.face-editor .panel')).toBeVisible();

  // Add a knob, bind it to the synth's cutoff, caption it.
  await page.locator('.kinds button', { hasText: 'Knob' }).click();
  await expect(page.locator('.surface .el.knob')).toBeVisible();
  await page.locator('.inspector select').first().selectOption(`${ids.synth}:cutoff`);
  await page.locator('.inspector label.full', { hasText: 'Caption' }).locator('input').fill('Cutoff');
  await page.locator('button', { hasText: 'Save Face' }).click();
  await expect(page.locator('.face-editor')).toBeHidden();

  const face = await page.evaluate((g) => window.__kk.graph.groups.get(g)!.face, groupId);
  expect(face!.elements).toHaveLength(1);
  expect(face!.elements[0].moduleId).toBe(ids.synth);
  expect(face!.elements[0].paramId).toBe('cutoff');

  // Drag the knob on the collapsed tile: default knob spot is (120,70) in
  // face-local px → knob center (155, 24+70+35) from the tile's top-left.
  const before = await page.evaluate(
    (i) => window.__kk.graph.modules.get(i)!.params.cutoff, ids.synth,
  );
  const pt = await page.evaluate((g) => window.__kkCanvas.clientPointForGroup(g), groupId);
  await page.mouse.move(pt!.x + 155, pt!.y + 129);
  await page.mouse.down();
  await page.mouse.move(pt!.x + 155, pt!.y + 69, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(
    (i) => window.__kk.graph.modules.get(i)!.params.cutoff, ids.synth,
  );
  expect(after).toBeGreaterThan(before);

  expect(errors).toEqual([]);
});

test('expand button opens the group; toolbar Shrink pulls it back into the face', async ({ page }) => {
  const ids = await start(page);
  const groupId = await makeGroup(page, ids);
  await page.evaluate((g) => {
    const s = window.__kk;
    const face = { width: 320, height: 220, grid: 10, snap: true, elements: [] };
    s.setGroupFace(g, face);
  }, groupId);

  // ⛶ expand button sits near the right edge of the title bar (w-66).
  await page.waitForTimeout(300); // let the rebuilt tile render before clicking
  const pt = await page.evaluate((g) => window.__kkCanvas.clientPointForGroup(g), groupId);
  await page.mouse.click(pt!.x + 320 - 70, pt!.y + 12);
  await expect
    .poll(() => page.evaluate((g) => window.__kk.graph.groups.get(g)!.collapsed, groupId))
    .toBe(false);

  // Select an inner module → toolbar Shrink collapses the group again.
  await page.evaluate((i) => window.__kk.select({ moduleId: i.synth }), ids);
  await page.locator('button.shrink').click();
  await expect
    .poll(() => page.evaluate((g) => window.__kk.graph.groups.get(g)!.collapsed, groupId))
    .toBe(true);

  // Double-tap on the title bar expands again (PRD §6 + spec).
  await page.waitForTimeout(300); // fresh tile needs a rendered frame first
  const pt2 = await page.evaluate((g) => window.__kkCanvas.clientPointForGroup(g), groupId);
  await page.mouse.dblclick(pt2!.x + 60, pt2!.y + 12);
  await expect
    .poll(() => page.evaluate((g) => window.__kk.graph.groups.get(g)!.collapsed, groupId))
    .toBe(false);
});

test('.kkmod export/import re-creates the faced group with fresh ids', async ({ page }) => {
  const ids = await start(page);
  const groupId = await makeGroup(page, ids);
  await page.evaluate(
    ([g, synth]) => {
      window.__kk.setGroupFace(g, {
        width: 320,
        height: 220,
        grid: 10,
        snap: true,
        elements: [
          { id: 'e1', kind: 'knob', x: 10, y: 10, w: 70, h: 86, moduleId: synth, paramId: 'cutoff' },
        ],
      });
    },
    [groupId, ids.synth] as const,
  );

  const result = await page.evaluate((g) => {
    const s = window.__kk;
    const text = s.exportFaceGroup(g);
    const imported = s.importFaceGroup(JSON.parse(JSON.stringify({ t: text })).t, { x: 600, y: 300 });
    const newGroup = s.graph.groups.get(imported.groupId!)!;
    const el = newGroup.face!.elements[0];
    return {
      ok: imported.ok,
      sameId: imported.groupId === g,
      boundInside: s.graph.modulesInGroup(imported.groupId!).has(el.moduleId!),
      boundToOld: el.moduleId === g,
      moduleCount: s.graph.modules.size,
    };
  }, groupId);

  expect(result.ok).toBe(true);
  expect(result.sameId).toBe(false);
  expect(result.boundInside).toBe(true);
  expect(result.moduleCount).toBeGreaterThan(7); // starter 7 + 2 imported
});

test('learn mode binds by clicking a param row on an inner module', async ({ page }) => {
  const ids = await start(page);
  const groupId = await makeGroup(page, ids);

  await page.locator('button.edit-face').click();
  await page.locator('.kinds button', { hasText: 'Knob' }).click();
  await page.locator('button', { hasText: 'Learn binding' }).click();
  await expect(page.locator('.learn-banner')).toBeVisible();

  // Arming auto-expanded the group; click the LFO's Rate row (row 2).
  await expect
    .poll(() => page.evaluate((g) => window.__kk.graph.groups.get(g)!.collapsed, groupId))
    .toBe(false);
  const lfoPt = await page.evaluate((i) => window.__kkCanvas.clientPointFor(i), ids.lfo);
  await page.mouse.click(lfoPt!.x - 10, lfoPt!.y - 65 + 52 + 10); // LFO is 180×130; rate row
  await expect(page.locator('.learn-banner')).toBeHidden();

  await page.locator('button', { hasText: 'Save Face' }).click();
  const el = await page.evaluate(
    (g) => window.__kk.graph.groups.get(g)!.face!.elements[0], groupId,
  );
  expect(el.moduleId).toBe(ids.lfo);
  expect(el.paramId).toBe('rate');
});

test('new blank face + embedding one faced group inside another', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  const ids = await start(page);

  // ✚ Face creates an empty designable group and opens the editor.
  await page.locator('button.new-face').click();
  await expect(page.locator('.face-editor .panel')).toBeVisible();
  await page.locator('button', { hasText: 'Cancel' }).click();
  const blankId = await page.evaluate(() => [...window.__kk.selectedGroupIds][0]);
  expect(blankId).toBeTruthy();
  const hasFace = await page.evaluate((g) => !!window.__kk.graph.groups.get(g)!.face, blankId);
  expect(hasFace).toBe(true);

  // Embed: group the blank face together with another faced group.
  const otherId = await makeGroup(page, ids);
  const parentId = await page.evaluate(
    ([a, b]) => {
      const s = window.__kk;
      s.clearSelection();
      s.addToSelection({ groupId: a });
      s.addToSelection({ groupId: b });
      return s.groupSelection();
    },
    [blankId, otherId] as const,
  );
  expect(parentId).toBeTruthy();
  const nested = await page.evaluate(
    ([p, a, b]) => {
      const g = window.__kk.graph.groups.get(p!)!;
      return g.groupIds.includes(a) && g.groupIds.includes(b);
    },
    [parentId, blankId, otherId] as const,
  );
  expect(nested).toBe(true);
  expect(errors).toEqual([]);
});
