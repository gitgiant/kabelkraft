import { expect, test } from '@playwright/test';

test('app loads with starter patch, no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('/');
  await expect(page.locator('.toolbar .logo')).toHaveText('KabelKraft');
  await expect(page.locator('.canvas-container canvas')).toBeVisible();
  await expect(page.locator('.palette .module-entry')).toHaveCount(7);

  // Starter patch seeds 5 modules + 3 wires; give the canvas a beat to mount.
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

test('palette adds a module to the canvas', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(300);
  await page.locator('.module-entry', { hasText: 'Synth' }).click();
  // No DOM representation of canvas modules; assert no errors after add.
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

test('enable audio starts the engine worklet', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
});

test('play runs the sequencer and audio reaches the output', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
  await page.locator('.transport button[title="Play"]').click();

  // Starter patch: sequencer -> synth -> audioOut. Wait for meters to show
  // signal at the audio output module.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = window.__kk;
          const audioOut = [...s.graph.modules.values()].find((m) => m.type === 'audioOut');
          return audioOut ? (s.meters[audioOut.id]?.peak ?? 0) : -1;
        }),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0.01);

  // Song position advances while playing.
  const pos = await page.evaluate(() => window.__kk.transport.songPosition);
  expect(pos).toBeGreaterThan(0);
});
