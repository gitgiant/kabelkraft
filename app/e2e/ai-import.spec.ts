import { expect, test } from '@playwright/test';
import { boot, bootWithAudio, play } from './util';

const PATCH = JSON.stringify({
  kind: 'kkgroup',
  formatVersion: 1,
  name: 'Bleep Group',
  modules: [
    { id: 'seq', type: 'sequencer' },
    { id: 'v', type: 'voice', params: { voices: 1 } },
    { id: 's', type: 'osc', params: { wave: 0, level: 0.6 } },
    { id: 'o', type: 'audioOut' },
  ],
  wires: [
    { from: { module: 'seq', port: 'notes' }, to: { module: 'v', port: 'notes' } },
    { from: { module: 'v', port: 'pitch' }, to: { module: 's', port: 'pitch' } },
    { from: { module: 's', port: 'out' }, to: { module: 'o', port: 'in' } },
  ],
});

test('AI import dialog: paste, import as group, audio flows', async ({ page }) => {
  await bootWithAudio(page);

  const before = await page.evaluate(() => ({
    modules: window.__kk.graph.modules.size,
    groups: window.__kk.graph.groups.size,
  }));

  await page.locator('.ai-toggle').click();
  await expect(page.locator('.ai-dialog')).toBeVisible();
  await page.locator('.ai-dialog textarea').fill(PATCH);
  await page.locator('.ai-dialog button.import').click();
  await expect(page.locator('.ai-dialog .success')).toBeVisible();

  const after = await page.evaluate(() => {
    const s = window.__kk;
    const group = [...s.graph.groups.values()].find((g) => g.name === 'Bleep Group');
    return {
      modules: s.graph.modules.size,
      groups: s.graph.groups.size,
      groupOk: !!group && group.moduleIds.length === 4,
      selected: group ? s.selectedGroupIds.has(group.id) : false,
    };
  });
  expect(after.modules).toBe(before.modules + 4);
  expect(after.groups).toBe(before.groups + 1);
  expect(after.groupOk).toBe(true);
  expect(after.selected).toBe(true);

  // The imported patch makes sound on its own wiring.
  await play(page);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = window.__kk;
          const group = [...s.graph.groups.values()].find((g) => g.name === 'Bleep Group')!;
          const synthId = group.moduleIds
            .map((id) => s.graph.modules.get(id)!)
            .find((m) => m.type === 'osc')!.id;
          return s.meters[synthId]?.peak ?? 0;
        }),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0.01);

  // Undo removes the whole import in one step.
  await page.evaluate(() => window.__kk.undo());
  const undone = await page.evaluate(() => ({
    modules: window.__kk.graph.modules.size,
    groups: window.__kk.graph.groups.size,
  }));
  expect(undone.modules).toBe(before.modules);
  expect(undone.groups).toBe(before.groups);
});

test('AI import dialog: bad patch shows readable errors, nothing inserted', async ({ page }) => {
  await boot(page);

  const before = await page.evaluate(() => window.__kk.graph.modules.size);
  await page.locator('.ai-toggle').click();
  await page
    .locator('.ai-dialog textarea')
    .fill(JSON.stringify({ modules: [{ id: 'a', type: 'superSaw' }] }));
  await page.locator('.ai-dialog button.import').click();

  await expect(page.locator('.ai-dialog .errors')).toBeVisible();
  await expect(page.locator('.ai-dialog .errors')).toContainText('superSaw');
  await expect(page.locator('.ai-dialog .errors')).toContainText('closest match');
  expect(await page.evaluate(() => window.__kk.graph.modules.size)).toBe(before);
});

test('markdown chatbot reply with a json block imports too', async ({ page }) => {
  await boot(page);

  const ok = await page.evaluate((patch) => {
    const reply = 'Sure! Here is your patch:\n```json\n' + patch + '\n```\nHave fun!';
    return window.__kk.importAiPatch(reply, { x: 0, y: 0 }).ok;
  }, PATCH);
  expect(ok).toBe(true);
});
