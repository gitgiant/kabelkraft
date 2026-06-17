import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  captureErrors,
  classicRig,
  clickUntil,
  dragVertical,
  faceElementCenter,
  faceKnobClient,
  groupLocalPoint,
  settleFrames,
  TILE_TITLE_H,
} from './util';

/**
 * Face passthrough views (FACE_VIEWS_PLAN.md P1): a 'view' face element embeds
 * a live member tile on the collapsed group tile; double-click opens the
 * member's editor, anchored onto the embed.
 */

async function startWithComposer(page: Page): Promise<{ comp: string; vcf: string; lfo: string }> {
  await boot(page);
  const rig = await classicRig(page);
  const comp = await page.evaluate(() => window.__kk.addModule('composer', -360, 200).id);
  await settleFrames(page);
  return { comp, vcf: rig.vcf, lfo: rig.lfo };
}

/** Group composer + vcf and return the group id. */
async function makeGroup(page: Page, ids: { comp: string; vcf: string }): Promise<string> {
  const groupId = await page.evaluate((i) => {
    const s = window.__kk;
    s.clearSelection();
    s.addToSelection({ moduleId: i.comp });
    s.addToSelection({ moduleId: i.vcf });
    return s.groupSelection()!;
  }, ids);
  await settleFrames(page);
  return groupId;
}

test('members list places a pre-bound view; saved face embeds the live tile', async ({ page }) => {
  const errors = captureErrors(page);
  const ids = await startWithComposer(page);
  const groupId = await makeGroup(page, ids);

  await page.locator('button.edit-face').click();
  await expect(page.locator('.face-editor .panel')).toBeVisible();

  // Members list offers every member module; clicking adds a bound view.
  await expect(page.locator('.members .member')).toHaveCount(2);
  await page.locator('.members .member', { hasText: 'Composer' }).click();
  await expect(page.locator('.surface .el.view')).toBeVisible();
  // Pre-bound — not flagged unbound, placeholder names the target.
  await expect(page.locator('.surface .el.view.unbound')).toHaveCount(0);
  await expect(page.locator('.surface .el.view')).toContainText('Composer');

  await page.locator('button', { hasText: 'Save Face' }).click();
  await expect(page.locator('.face-editor')).toBeHidden();

  const el = await page.evaluate((g) => window.__kk.graph.groups.get(g)!.face!.elements[0], groupId);
  expect(el.kind).toBe('view');
  expect(el.moduleId).toBe(ids.comp);
  expect(errors).toEqual([]);
});

test('palette 🗔 View starts unbound; inspector dropdown binds a member', async ({ page }) => {
  const ids = await startWithComposer(page);
  const groupId = await makeGroup(page, ids);

  await page.locator('button.edit-face').click();
  await page.locator('.kinds button', { hasText: 'View' }).click();
  await expect(page.locator('.surface .el.view.unbound')).toBeVisible();

  await page.locator('.inspector select:not(.add-pole)').first().selectOption(`m:${ids.comp}`);
  await expect(page.locator('.surface .el.view.unbound')).toHaveCount(0);

  await page.locator('button', { hasText: 'Save Face' }).click();
  const el = await page.evaluate((g) => window.__kk.graph.groups.get(g)!.face!.elements[0], groupId);
  expect(el.moduleId).toBe(ids.comp);
});

test('double-click on the embedded composer view opens the piano roll over the tile', async ({ page }) => {
  const errors = captureErrors(page);
  const ids = await startWithComposer(page);
  const groupId = await makeGroup(page, ids);

  // Face with one composer view, placed programmatically (deterministic rect).
  await page.evaluate(
    ([g, comp]) => {
      window.__kk.setGroupFace(g, {
        width: 320,
        height: 220,
        grid: 10,
        snap: true,
        elements: [{ id: 'e1', kind: 'view', x: 20, y: 20, w: 280, h: 180, moduleId: comp }],
      });
    },
    [groupId, ids.comp] as const,
  );
  await settleFrames(page);

  // Double-click the view center until the roll opens (tile rebuild timing).
  await clickUntil(
    page,
    async () => {
      const pt = await page.evaluate((g) => window.__kkCanvas.clientPointForGroup(g), groupId);
      return pt && groupLocalPoint(pt, 20 + 140, TILE_TITLE_H + 20 + 90);
    },
    () => page.evaluate((c) => window.__kk.composerOpen.has(c), ids.comp),
    { dblclick: true },
  );

  // The roll anchors onto the embed (clientRectFor fallback) — visible means
  // the rect resolved even though the canvas composer tile is hidden.
  await expect(page.locator('.piano-roll')).toBeVisible();
  expect(errors).toEqual([]);
});

/** Child group (vcf+lfo) with a faced knob, nested inside a parent group. */
async function makeNested(page: Page, ids: { comp: string; vcf: string; lfo: string }): Promise<{ childId: string; parentId: string }> {
  const childId = await page.evaluate((i) => {
    const s = window.__kk;
    s.clearSelection();
    s.addToSelection({ moduleId: i.vcf });
    s.addToSelection({ moduleId: i.lfo });
    const g = s.groupSelection()!;
    s.setGroupFace(g, {
      width: 320,
      height: 220,
      grid: 10,
      snap: true,
      elements: [{ id: 'e1', kind: 'knob', x: 10, y: 10, w: 70, h: 86, moduleId: i.vcf, paramId: 'cutoff' }],
    });
    return g;
  }, ids);
  const parentId = await page.evaluate(
    ([child, comp]) => {
      const s = window.__kk;
      s.clearSelection();
      s.addToSelection({ groupId: child });
      s.addToSelection({ moduleId: comp });
      return s.groupSelection()!;
    },
    [childId, ids.comp] as const,
  );
  await settleFrames(page);
  return { childId, parentId };
}

test('child-group sub-panel: knob on the embedded face drives the inner param', async ({ page }) => {
  const errors = captureErrors(page);
  const ids = await startWithComposer(page);
  const { childId, parentId } = await makeNested(page, ids);

  // Parent face = one full-size view of the child's 320×220 face → scale 1,
  // no letterbox: the child's face area maps 1:1 onto the parent's.
  await page.evaluate(
    ([parent, child]) => {
      window.__kk.setGroupFace(parent, {
        width: 320,
        height: 220,
        grid: 10,
        snap: true,
        elements: [{ id: 'e1', kind: 'view', x: 0, y: 0, w: 320, h: 220, groupId: child }],
      });
    },
    [parentId, childId] as const,
  );
  await settleFrames(page);

  const before = await page.evaluate((i) => window.__kk.graph.modules.get(i)!.params.cutoff, ids.vcf);
  // Child knob at face (10,10,70×86): rotary center = +w/2 into the face area.
  const pt = await page.evaluate((g) => window.__kkCanvas.clientPointForGroup(g), parentId);
  const knob = faceElementCenter(pt!, { x: 10, y: 10, w: 70 });
  await dragVertical(page, knob, -60);
  await expect
    .poll(() => page.evaluate((i) => window.__kk.graph.modules.get(i)!.params.cutoff, ids.vcf))
    .toBeGreaterThan(before);
  expect(errors).toEqual([]);
});

test('double-click on a sub-panel drills in: child and parent expand', async ({ page }) => {
  const ids = await startWithComposer(page);
  const { childId, parentId } = await makeNested(page, ids);
  await page.evaluate(
    ([parent, child]) => {
      window.__kk.setGroupFace(parent, {
        width: 320,
        height: 220,
        grid: 10,
        snap: true,
        elements: [{ id: 'e1', kind: 'view', x: 0, y: 0, w: 320, h: 220, groupId: child }],
      });
    },
    [parentId, childId] as const,
  );
  await settleFrames(page);

  // Double-click sub-panel background (clear of the child's knob at 10,10).
  await clickUntil(
    page,
    async () => {
      const pt = await page.evaluate((g) => window.__kkCanvas.clientPointForGroup(g), parentId);
      return pt && groupLocalPoint(pt, 250, TILE_TITLE_H + 160);
    },
    () =>
      page.evaluate(
        ([p, c]) =>
          !window.__kk.graph.groups.get(p)!.collapsed && !window.__kk.graph.groups.get(c)!.collapsed,
        [parentId, childId] as const,
      ),
    { dblclick: true },
  );
});

test('members list offers child groups; clicking embeds a pre-bound sub-panel', async ({ page }) => {
  const errors = captureErrors(page);
  const ids = await startWithComposer(page);
  const { childId, parentId } = await makeNested(page, ids);

  await page.evaluate((g) => {
    window.__kk.clearSelection();
    window.__kk.addToSelection({ groupId: g });
  }, parentId);
  await page.locator('button.edit-face').click();
  await expect(page.locator('.face-editor .panel')).toBeVisible();

  // Child group leads the members list; click adds a group-bound view.
  await page.locator('.members .member', { hasText: '▣' }).first().click();
  await expect(page.locator('.surface .el.view')).toBeVisible();
  await expect(page.locator('.surface .el.view.unbound')).toHaveCount(0);

  await page.locator('button', { hasText: 'Save Face' }).click();
  const el = await page.evaluate((g) => window.__kk.graph.groups.get(g)!.face!.elements[0], parentId);
  expect(el.kind).toBe('view');
  expect(el.groupId).toBe(childId);
  expect(el.moduleId).toBeUndefined();
  expect(errors).toEqual([]);
});

test('Init Poly Synth starter: nested sub-panels, views and XY live on the boot tile', async ({ page }) => {
  const errors = captureErrors(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);

  const info = await page.evaluate(() => {
    const s = window.__kk;
    const parent = [...s.graph.groups.values()].find((g) => g.name === 'Poly Synth')!;
    const els = parent.face!.elements;
    return {
      parentId: parent.id,
      children: parent.groupIds.length,
      groupViews: els.filter((e) => e.kind === 'view' && e.groupId).length,
      moduleViews: els.filter((e) => e.kind === 'view' && e.moduleId).length,
      hasXy: els.some((e) => e.kind === 'xy'),
      reverbId: [...s.graph.modules.values()].find((m) => m.type === 'reverb')!.id,
    };
  });
  expect(info.children).toBe(3); // Oscillators / Envelopes / FX
  expect(info.groupViews).toBe(3);
  expect(info.moduleViews).toBe(2); // composer clip + filter curve
  expect(info.hasXy).toBe(true);

  // Drag the FX sub-panel's reverb Mix knob THROUGH the parent face — its
  // client position is walked from the live face tree (nested group embed), so
  // a starter-patch face redesign re-locates it instead of breaking the test.
  const before = await page.evaluate((i) => window.__kk.graph.modules.get(i)!.params.mix, info.reverbId);
  await settleFrames(page);
  const knob = (await faceKnobClient(page, info.parentId, info.reverbId, 'mix'))!;
  expect(knob).not.toBeNull();
  await dragVertical(page, knob, -50);
  await expect
    .poll(() => page.evaluate((i) => window.__kk.graph.modules.get(i)!.params.mix, info.reverbId))
    .toBeGreaterThan(before);
  expect(errors).toEqual([]);
});

test('view bindings prune when the target leaves the group; unbound view renders placeholder', async ({ page }) => {
  const errors = captureErrors(page);
  const ids = await startWithComposer(page);
  const groupId = await makeGroup(page, ids);
  await page.evaluate(
    ([g, comp]) => {
      window.__kk.setGroupFace(g, {
        width: 320,
        height: 220,
        grid: 10,
        snap: true,
        elements: [{ id: 'e1', kind: 'view', x: 20, y: 20, w: 280, h: 180, moduleId: comp }],
      });
    },
    [groupId, ids.comp] as const,
  );
  await settleFrames(page);

  // Remove the composer — reopening the editor prunes the dead binding.
  await page.evaluate((c) => window.__kk.removeModule(c), ids.comp);
  await settleFrames(page);
  await page.evaluate((g) => {
    window.__kk.clearSelection();
    window.__kk.addToSelection({ groupId: g });
  }, groupId);
  await page.locator('button.edit-face').click();
  await expect(page.locator('.surface .el.view.unbound')).toBeVisible();
  await page.locator('button', { hasText: 'Save Face' }).click();

  const el = await page.evaluate((g) => window.__kk.graph.groups.get(g)!.face!.elements[0], groupId);
  expect(el.kind).toBe('view');
  expect(el.moduleId).toBeUndefined();
  expect(errors).toEqual([]);
});
