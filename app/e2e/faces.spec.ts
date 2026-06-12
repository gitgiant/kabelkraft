import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  captureErrors,
  classicRig,
  clickUntil,
  dragVertical,
  faceElementCenter,
  groupExpandButton,
  settleFrames,
} from './util';

/**
 * Module face designer (PRD §6 macro controls as a design framework):
 * editor overlay, faced collapsed tiles, expand/shrink, .kkmod round-trip.
 */

async function start(page: Page): Promise<{ synth: string; lfo: string }> {
  await boot(page);
  // Classic flat rig: these specs group synth+lfo themselves and would
  // collide with the shipping starter patch's pre-made faced group.
  const rig = await classicRig(page);
  // These specs bind a "cutoff" param, so the stand-in module is the filter.
  return { synth: rig.vcf, lfo: rig.lfo };
}

/** Group synth+lfo and return the group id (selected afterwards). */
async function makeGroup(page: Page, ids: { synth: string; lfo: string }): Promise<string> {
  const groupId = await page.evaluate((i) => {
    const s = window.__kk;
    s.clearSelection();
    s.addToSelection({ moduleId: i.synth });
    s.addToSelection({ moduleId: i.lfo });
    return s.groupSelection()!;
  }, ids);
  await settleFrames(page); // freshly built tile needs rendered frames before hit-testing
  return groupId;
}

test('design a face in the editor; the collapsed tile knob drives the inner param', async ({ page }) => {
  const errors = captureErrors(page);
  const ids = await start(page);
  const groupId = await makeGroup(page, ids);

  // Toolbar → editor.
  await page.locator('button.edit-face').click();
  await expect(page.locator('.face-editor .panel')).toBeVisible();

  // Add a knob, bind it to the synth's cutoff, caption it.
  await page.locator('.kinds button', { hasText: 'Knob' }).click();
  await expect(page.locator('.surface .el.knob')).toBeVisible();
  // `.inspector` also holds the Group Poles "add" dropdown; the element binding
  // select is the first non-pole one.
  await page.locator('.inspector select:not(.add-pole)').first().selectOption(`${ids.synth}:cutoff`);
  await page.locator('.inspector label.full', { hasText: 'Caption' }).locator('input').fill('Cutoff');
  await page.locator('button', { hasText: 'Save Face' }).click();
  await expect(page.locator('.face-editor')).toBeHidden();

  const face = await page.evaluate((g) => window.__kk.graph.groups.get(g)!.face, groupId);
  expect(face!.elements).toHaveLength(1);
  expect(face!.elements[0].moduleId).toBe(ids.synth);
  expect(face!.elements[0].paramId).toBe('cutoff');

  // Drag the knob on the collapsed tile — position comes from the saved face
  // element, not hard-coded pixels.
  const before = await page.evaluate(
    (i) => window.__kk.graph.modules.get(i)!.params.cutoff, ids.synth,
  );
  await settleFrames(page);
  const pt = await page.evaluate((g) => window.__kkCanvas.clientPointForGroup(g), groupId);
  const knob = faceElementCenter(pt!, face!.elements[0]);
  await dragVertical(page, knob, -60);
  const after = await page.evaluate(
    (i) => window.__kk.graph.modules.get(i)!.params.cutoff, ids.synth,
  );
  expect(after).toBeGreaterThan(before);

  expect(errors).toEqual([]);
});

test('expand button opens the group; toolbar Shrink pulls it back into the face', async ({ page }) => {
  const ids = await start(page);
  const groupId = await makeGroup(page, ids);
  const faceWidth = 320;
  await page.evaluate(([g, w]) => {
    const s = window.__kk;
    s.setGroupFace(g as string, { width: w as number, height: 220, grid: 10, snap: true, elements: [] });
  }, [groupId, faceWidth] as const);
  // ⛶ expand button sits near the right edge of the title bar; retry until
  // the freshly rebuilt tile accepts the click.
  await clickUntil(
    page,
    async () => {
      const pt = await page.evaluate((g) => window.__kkCanvas.clientPointForGroup(g), groupId);
      return pt && groupExpandButton(pt, faceWidth);
    },
    () => page.evaluate((g) => !window.__kk.graph.groups.get(g)!.collapsed, groupId),
  );

  // Select an inner module → toolbar Shrink collapses the group again.
  await page.evaluate((i) => window.__kk.select({ moduleId: i.synth }), ids);
  await page.locator('button.shrink').click();
  await expect
    .poll(() => page.evaluate((g) => window.__kk.graph.groups.get(g)!.collapsed, groupId))
    .toBe(true);

  // Double-tap on the title bar expands again (PRD §6 + spec).
  await clickUntil(
    page,
    async () => {
      const pt = await page.evaluate((g) => window.__kkCanvas.clientPointForGroup(g), groupId);
      return pt && { x: pt.x + 60, y: pt.y + 12 };
    },
    () => page.evaluate((g) => !window.__kk.graph.groups.get(g)!.collapsed, groupId),
    { dblclick: true },
  );
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

  const before = await page.evaluate(() => window.__kk.graph.modules.size);
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
      importedCount: s.graph.groups.get(imported.groupId!)!.moduleIds.length,
      moduleCount: s.graph.modules.size,
    };
  }, groupId);

  expect(result.ok).toBe(true);
  expect(result.sameId).toBe(false);
  expect(result.boundInside).toBe(true);
  // Import adds the group's modules as fresh copies.
  expect(result.moduleCount).toBe(before + result.importedCount);
});

test('learn mode binds by clicking a param row on an inner module', async ({ page }) => {
  // Larger modules push the LFO's rate knob below the default 720px viewport.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ids = await start(page);
  const groupId = await makeGroup(page, ids);

  await page.locator('button.edit-face').click();
  await page.locator('.kinds button', { hasText: 'Knob' }).click();
  await page.locator('button', { hasText: 'Learn binding' }).click();
  await expect(page.locator('.learn-banner')).toBeVisible();

  // Arming auto-expanded the group; click the LFO's Rate row.
  await expect
    .poll(() => page.evaluate((g) => window.__kk.graph.groups.get(g)!.collapsed, groupId))
    .toBe(false);
  // Freshly rebuilt tiles need rendered frames before hit-testing — retry
  // the click until the learn banner reports the binding landed.
  await clickUntil(
    page,
    () => page.evaluate((i) => window.__kkCanvas.clientPointForParam(i, 'rate'), ids.lfo),
    () => page.locator('.learn-banner').isHidden(),
  );

  await page.locator('button', { hasText: 'Save Face' }).click();
  const el = await page.evaluate(
    (g) => window.__kk.graph.groups.get(g)!.face!.elements[0], groupId,
  );
  expect(el.moduleId).toBe(ids.lfo);
  expect(el.paramId).toBe('rate');
});

test('new blank face + embedding one faced group inside another', async ({ page }) => {
  const errors = captureErrors(page);
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

test('AI face: copy spec opens paste box; pasted kkface reply fills the draft', async ({ page }) => {
  const errors = captureErrors(page);
  const ids = await start(page);
  const groupId = await makeGroup(page, ids);

  await page.locator('button.edit-face').click();
  await expect(page.locator('.face-editor .panel')).toBeVisible();

  // No provider configured in e2e: 📋 copies spec + context, opens paste box.
  await page.locator('button.ai-copy').click();
  await expect(page.locator('.ai-paste textarea')).toBeVisible();

  const reply = await page.evaluate(
    (i) =>
      JSON.stringify({
        kind: 'kkface',
        width: 300,
        height: 180,
        elements: [
          { kind: 'label', x: 10, y: 4, text: 'SYNTH' },
          { kind: 'knob', x: 10, y: 30, label: 'Cutoff', module: i.synth, param: 'cutoff' },
          { kind: 'knob', x: 90, y: 30, label: 'Ghost', module: 'nope', param: 'x' }, // unbound
        ],
      }),
    ids,
  );
  await page.locator('.ai-paste textarea').fill(reply);
  await page.locator('button.ai-paste-apply').click();

  // Draft replaced: three elements on the surface, ghost knob unbound.
  await expect(page.locator('.surface .el')).toHaveCount(3);
  await expect(page.locator('.surface .el.unbound')).toHaveCount(1);

  await page.locator('button', { hasText: 'Save Face' }).click();
  const face = await page.evaluate((g) => window.__kk.graph.groups.get(g)!.face, groupId);
  expect(face!.elements).toHaveLength(3);
  const knob = face!.elements.find((e) => e.kind === 'knob' && e.moduleId);
  expect(knob?.moduleId).toBe(ids.synth);
  expect(knob?.paramId).toBe('cutoff');
  expect(errors).toEqual([]);
});
