import { expect, test, type Page } from '@playwright/test';
import { bootWithAudio, captureErrors, settleFrames } from './util';

/** Minimal valid 16-bit mono WAV so decodeAudioData accepts it. */
function wavBuffer(freq = 440, seconds = 0.1): Buffer {
  const rate = 44100;
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), 44 + i * 2);
  }
  return buf;
}

/** Open the panel and add two files through the fallback picker. */
async function openWithFiles(page: Page): Promise<void> {
  await bootWithAudio(page);
  // Samples now live in the module palette's "Samples" tab (1515c55).
  await page.getByRole('tab', { name: 'Samples' }).click();
  await expect(page.locator('.library')).toBeVisible();
  await page.locator('.library input[type="file"]').setInputFiles([
    { name: 'kickme.wav', mimeType: 'audio/wav', buffer: wavBuffer(60) },
    { name: 'snare-x.wav', mimeType: 'audio/wav', buffer: wavBuffer(220) },
  ]);
  await expect(page.locator('.library .entry')).toHaveCount(2);
}

test('panel toggles, files add via fallback, search filters', async ({ page }) => {
  await openWithFiles(page);

  await page.locator('.library .search').fill('kick');
  await expect(page.locator('.library .entry')).toHaveCount(1);
  await expect(page.locator('.library .entry-name')).toHaveText('kickme.wav');
  await page.locator('.library .search').fill('');
  await expect(page.locator('.library .entry')).toHaveCount(2);

  // Switch back to the Modules tab; the library unmounts.
  await page.getByRole('tab', { name: 'Modules' }).click();
  await expect(page.locator('.library')).toBeHidden();
});

test('favorites star, filter, and persist in localStorage', async ({ page }) => {
  await openWithFiles(page);

  await page.locator('.library .entry', { hasText: 'kickme' }).locator('.fav').click();
  await page.locator('.library .fav-filter').click();
  await expect(page.locator('.library .entry')).toHaveCount(1);
  await expect(page.locator('.library .entry-name')).toHaveText('kickme.wav');

  const stored = await page.evaluate(() => localStorage.getItem('kk-lib-favs'));
  expect(stored).toContain('files/kickme.wav');
  await page.evaluate(() => localStorage.removeItem('kk-lib-favs'));
});

test('drag a library row onto a Sample Voice loads the sample', async ({ page }) => {
  await openWithFiles(page);

  const samplerId = await page.evaluate(() => {
    const s = window.__kk;
    for (const g of [...s.graph.groups.keys()]) s.ungroup(g); // clean slate (starter groups too)
    for (const m of [...s.graph.modules.values()]) s.removeModule(m.id);
    return s.addModule('smpl', 0, 0).id;
  });

  const row = page.locator('.library .entry', { hasText: 'kickme' });
  const rowBox = (await row.boundingBox())!;
  const target = await page.evaluate((id) => window.__kkCanvas.clientPointFor(id)!, samplerId);

  await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await expect(page.locator('.drag-ghost')).toBeVisible();
  await page.mouse.up();

  await expect
    .poll(() => page.evaluate((id) => window.__kk.samples.get(id)?.name ?? '', samplerId))
    .toBe('kickme.wav');
});

test('clicking a row auditions without errors', async ({ page }) => {
  const errors = captureErrors(page);
  await openWithFiles(page);

  await page.locator('.library .entry', { hasText: 'kickme' }).locator('.entry-name').click();
  await settleFrames(page, 20); // decode + audition start are async; let errors surface
  expect(errors).toEqual([]);
});
