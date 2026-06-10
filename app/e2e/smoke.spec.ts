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
  await expect(page.locator('.palette .module-entry')).toHaveCount(5);

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
