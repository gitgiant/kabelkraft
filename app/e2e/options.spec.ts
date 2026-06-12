import { expect, test } from '@playwright/test';
import { boot, bootWithAudio, captureErrors, settleFrames } from './util';

/* Options dialog (OPTIONS_MENU_PLAN.md): unified settings + per-project tab. */

test('opens via ⚙ and Cmd+, toggles; Esc closes', async ({ page }) => {
  const errors = captureErrors(page);
  await boot(page);

  await page.locator('.options-toggle').click();
  await expect(page.locator('.options-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.options-dialog')).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+Comma');
  await expect(page.locator('.options-dialog')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Comma');
  await expect(page.locator('.options-dialog')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('project tab edits name, tempo, time signature and metadata into the save', async ({ page }) => {
  await boot(page);
  await page.locator('.options-toggle').click();

  await page.locator('.opt-project-name').fill('Options Spec');
  await page.locator('.opt-project-name').blur();
  await page.locator('.opt-bpm').fill('93');
  await page.locator('.opt-bpm').blur();
  await page.locator('.opt-ts-num').fill('7');
  await page.locator('.opt-ts-denom').selectOption('8');
  await page.locator('.opt-artists').fill('The Patchers');
  await page.locator('.opt-artists').blur();
  await page.locator('.opt-description').fill('seven-eight workout');
  await page.locator('.opt-description').blur();

  const saved = await page.evaluate(() => JSON.parse(window.__kk.serializeWithSamples()));
  expect(saved.name).toBe('Options Spec');
  expect(Math.round(saved.transport.tempo)).toBe(93);
  expect(saved.transport.timeSignature).toEqual({ num: 7, denom: 8 });
  expect(saved.meta.artists).toBe('The Patchers');
  expect(saved.meta.description).toBe('seven-eight workout');

  // Toolbar's name field follows the dialog edit.
  await expect(page.locator('.project-name')).toHaveValue('Options Spec');
});

test('display tab: UI scale zooms the page, visualizer caps persist', async ({ page }) => {
  await boot(page);
  await page.locator('.options-toggle').click();
  await page.locator('.options-tabs .tab[data-tab="display"]').click();

  await page.locator('.opt-ui-scale').selectOption('1.25');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.zoom))
    .toBe('1.25');

  await page.locator('.opt-vis-fps').selectOption('60');
  await page.locator('.opt-vis-res').selectOption('0.5');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('kk-settings')!));
  expect(stored.display.uiScale).toBe(1.25);
  expect(stored.display.visMaxFps).toBe(60);
  expect(stored.display.visMaxRes).toBe(0.5);

  // Back to 100% so later mouse math in this browser context stays sane.
  await page.locator('.opt-ui-scale').selectOption('1');
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('');
  await page.evaluate(() => localStorage.removeItem('kk-settings'));
});

test('AI dialog Setup opens Options on the AI tab', async ({ page }) => {
  await boot(page);
  await page.locator('.ai-toggle').click();
  await page.locator('.setup-btn').click();
  await expect(page.locator('.options-dialog')).toBeVisible();
  await expect(page.locator('.options-tabs .tab[data-tab="ai"]')).toHaveClass(/active/);
  // The embedded backend panel renders.
  await expect(page.locator('.options-dialog .settings select').first()).toBeVisible();
});

test('legacy kk-theme migrates into the unified settings on boot', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kk-theme', 'light'));
  await boot(page);
  const stored = await page.evaluate(() => ({
    unified: JSON.parse(localStorage.getItem('kk-settings')!).display.theme,
    legacy: localStorage.getItem('kk-theme'),
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  }));
  expect(stored.unified).toBe('light');
  expect(stored.legacy).toBeNull();
  expect(stored.bg).toBe('#e9e9ef'); // light theme applied at init
  await page.evaluate(() => localStorage.removeItem('kk-settings'));
});

test('MIDI tab lists learned mappings and deletes them', async ({ page }) => {
  await boot(page);
  const oscId = await page.evaluate(() => {
    const s = window.__kk;
    const osc = s.addModule('osc', 0, 0);
    s.midiMap.set('1:74', { moduleId: osc.id, paramId: 'detune' });
    return osc.id;
  });

  await page.locator('.options-toggle').click();
  await page.locator('.options-tabs .tab[data-tab="midi"]').click();
  const row = page.locator('.mapping', { hasText: 'CC 74' });
  await expect(row).toBeVisible();
  expect(await row.textContent()).toContain(oscId);

  await row.locator('button').click();
  await expect(page.locator('.mapping')).toHaveCount(0);
  expect(await page.evaluate(() => window.__kk.midiMap.size)).toBe(0);
});

test('audio tab: master volume + latency restart keep the engine alive', async ({ page }) => {
  await bootWithAudio(page);
  await page.locator('.options-toggle').click();
  await page.locator('.options-tabs .tab[data-tab="audio"]').click();

  // Mute writes through to settings; the engine object stays up.
  await page.locator('.opt-mute').check();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('kk-settings')!).audio.muted),
  ).toBe(true);
  await page.locator('.opt-mute').uncheck();

  // Construction-time change → automatic engine rebuild, still running after.
  await page.locator('.opt-latency').selectOption('playback');
  await expect.poll(() => page.evaluate(() => window.__kk.engine.running), { timeout: 5000 }).toBe(true);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('kk-settings')!).audio.latencyHint),
  ).toBe('playback');
  await page.evaluate(() => localStorage.removeItem('kk-settings'));
});

test('debug tab shows live counts and engine state', async ({ page }) => {
  await boot(page);
  await page.locator('.options-toggle').click();
  await page.locator('.options-tabs .tab[data-tab="debug"]').click();

  await expect(page.locator('.opt-fps')).toBeVisible();
  await expect
    .poll(async () => Number((await page.locator('.opt-fps').textContent())?.split(' ')[0]))
    .toBeGreaterThan(0);
  const counts = await page.evaluate(() => window.__kk.graph.modules.size);
  await expect(page.locator('.debug-grid')).toContainText(`${counts} modules`);
});

test('autosave writes a session record and offers restore on reload', async ({ page }) => {
  test.slow(); // autosave minimum interval is 5 s
  await boot(page);

  // Minimum interval via the dialog so the test doesn't wait 30 s.
  await page.locator('.options-toggle').click();
  await page.locator('.options-tabs .tab[data-tab="general"]').click();
  await page.locator('.opt-autosave-interval').fill('5');
  await page.locator('.opt-autosave-interval').blur();
  await page.keyboard.press('Escape');

  // Dirty the graph, then wait for the IndexedDB record to appear.
  await page.evaluate(() => void window.__kk.addModule('osc', 50, 50));
  await settleFrames(page);
  const readRecord = () =>
    page.evaluate(
      () =>
        new Promise<string | null>((resolve) => {
          const req = indexedDB.open('kk-autosave', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('session');
          req.onsuccess = () => {
            const db = req.result;
            const get = db.transaction('session').objectStore('session').get('last');
            get.onsuccess = () => {
              db.close();
              resolve(get.result ? (get.result.projectName as string) : null);
            };
            get.onerror = () => {
              db.close();
              resolve(null);
            };
          };
          req.onerror = () => resolve(null);
        }),
    );
  await expect.poll(readRecord, { timeout: 15000, intervals: [1000] }).not.toBeNull();

  await page.reload();
  await expect(page.locator('.restore-dialog')).toBeVisible({ timeout: 10000 });
  await page.locator('.restore-yes').click();
  await expect(page.locator('.restore-dialog')).toHaveCount(0);
  // The autosaved patch (starter + extra osc) is back.
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__kk.graph.modules.values()].filter((m) => m.type === 'osc').length,
      ),
    )
    .toBeGreaterThan(0);
});

test('storage tab reports the autosave record and clears it', async ({ page }) => {
  await boot(page);
  await page.locator('.options-toggle').click();
  await page.locator('.options-tabs .tab[data-tab="storage"]').click();
  await expect(page.locator('.opt-autosave-size')).toBeVisible();
  await page.locator('.clear-autosave').click();
  await expect(page.locator('.opt-autosave-size')).toHaveText(/0 B|–/);
});
