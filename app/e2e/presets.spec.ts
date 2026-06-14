import { test, expect } from '@playwright/test';
import { boot, captureErrors, settleFrames } from './util';

// Smoke coverage for module/container presets (PRESETS_PLAN.md): the menu
// renders, save/load round-trips through state + engine sync, dirty tracks
// live edits, and the AI panel surfaces the configure link with no provider.

test('module preset: default, dirty, save-as, load round-trip', async ({ page }) => {
  const errors = captureErrors(page);
  page.on('dialog', (d) => d.accept());
  await boot(page);

  const id = await page.evaluate(() => {
    const s = window.__kk;
    return [...s.graph.modules.values()].find((m) => s.graph.def(m.type).params.length > 0)!.id;
  });
  const target = { id, isGroup: false };

  // Open the preset menu for the module.
  await page.evaluate((t) => {
    window.__kk.ensureDefaultPreset(t);
    window.__kk.openPresetMenu(t, 80, 80);
  }, target);
  await expect(page.locator('.preset-menu')).toBeVisible();
  await expect(page.locator('.preset-menu .pick.active')).toContainText('Default');

  // A param change dirties the active preset → Save/Revert enable.
  const param = await page.evaluate((mid) => {
    const def = window.__kk.graph.def(window.__kk.graph.modules.get(mid)!.type);
    return def.params[0]?.id ?? null;
  }, id);
  expect(param).not.toBeNull();
  await page.evaluate(
    ({ mid, p }) => {
      const mod = window.__kk.graph.modules.get(mid)!;
      window.__kk.setParam(mid, p, (mod.params[p] ?? 0) + 1);
    },
    { mid: id, p: param },
  );
  await expect.poll(() => page.evaluate((t) => window.__kk.isPresetDirty(t), target)).toBe(true);

  // Save As a new preset in a category.
  const menu = page.locator('.preset-menu');
  await menu.getByRole('button', { name: 'Save As…' }).click();
  await menu.locator('input').first().fill('Bright');
  await menu.locator('input').nth(1).fill('Lead');
  await menu.getByRole('button', { name: 'Save', exact: true }).click();

  await expect.poll(() => page.evaluate((t) => window.__kk.presetsOf(t).length, target)).toBe(2);
  expect(await page.evaluate((t) => window.__kk.activePreset(t)?.name, target)).toBe('Bright');

  // Reopen the menu and load the Default preset back.
  const dirtyValue = await page.evaluate((mid) => window.__kk.graph.modules.get(mid)!.params, id);
  await page.evaluate((t) => window.__kk.openPresetMenu(t, 80, 80), target);
  await menu.getByRole('button', { name: /Default/ }).click();

  const loaded = await page.evaluate((t) => window.__kk.activePreset(t)?.name, target);
  expect(loaded).toBe('Default');
  const reverted = await page.evaluate((mid) => window.__kk.graph.modules.get(mid)!.params, id);
  expect(reverted[param!]).not.toBe(dirtyValue[param!]);

  expect(errors).toEqual([]);
});

test('container preset + AI panel surfaces configure link without a provider', async ({ page }) => {
  const errors = captureErrors(page);
  await boot(page);

  // Group two starter modules into a container.
  const groupId = await page.evaluate(() => {
    const s = window.__kk;
    const ids = [...s.graph.modules.keys()].slice(0, 2);
    return s.graph.createGroup('Rig', ids, [], 0, 0).id;
  });
  await settleFrames(page);
  const target = { id: groupId, isGroup: true };

  await page.evaluate((t) => {
    window.__kk.ensureDefaultPreset(t);
    window.__kk.openPresetMenu(t, 80, 80);
  }, target);
  await expect(page.locator('.preset-menu')).toBeVisible();

  // Container default snapshot captured its members.
  const members = await page.evaluate(
    (t) => Object.keys(window.__kk.activePreset(t)?.members ?? {}).length,
    target,
  );
  expect(members).toBe(2);

  // AI panel: with no provider, Generate shows the configure link.
  const menu = page.locator('.preset-menu');
  await menu.getByRole('button', { name: '✨ Generate with AI' }).click();
  await menu.locator('textarea').first().fill('fat bass');
  await menu.getByRole('button', { name: '✨ Generate', exact: true }).click();
  await expect(menu.locator('.link')).toBeVisible();

  expect(errors).toEqual([]);
});
