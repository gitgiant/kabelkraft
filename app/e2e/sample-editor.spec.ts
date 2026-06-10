import { expect, test } from '@playwright/test';

/** Inject a sampler with ramp PCM and open the editor on it. */
async function openEditorOnSampler(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
  const samplerId = await page.evaluate(() => {
    const s = window.__kk;
    const sampler = s.addModule('sampler', 0, 500);
    const n = 44100;
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) pcm[i] = (i / n) * 0.8;
    s.setSample(sampler.id, { name: 'ramp.wav', sampleRate: 44100, channels: [pcm] });
    s.openSampleEditor(sampler.id);
    return sampler.id;
  });
  await expect(page.locator('.sample-editor')).toBeVisible();
  return samplerId;
}

test('editor reverses and saves back to the store', async ({ page }) => {
  const samplerId = await openEditorOnSampler(page);

  await page.locator('.sample-editor button', { hasText: 'Reverse' }).click();
  const save = page.locator('.sample-editor button', { hasText: 'Save' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator('.sample-editor')).toBeHidden();

  const first = await page.evaluate(
    (id) => window.__kk.samples.get(id)!.channels[0][0],
    samplerId,
  );
  expect(first).toBeGreaterThan(0.79); // ramp end now at the front
});

test('cancel discards edits (non-destructive)', async ({ page }) => {
  const samplerId = await openEditorOnSampler(page);

  await page.locator('.sample-editor button', { hasText: 'Reverse' }).click();
  await page.locator('.sample-editor button', { hasText: 'Cancel' }).click();
  await expect(page.locator('.sample-editor')).toBeHidden();

  const first = await page.evaluate(
    (id) => window.__kk.samples.get(id)!.channels[0][0],
    samplerId,
  );
  expect(first).toBeCloseTo(0); // untouched ramp
});

test('drag-select then trim shortens a drum pad sample', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });

  const drumId = await page.evaluate(() => {
    const s = window.__kk;
    const drum = s.addModule('drum', 0, 700);
    s.openSampleEditor(drum.id, 0); // kick pad
    return drum.id;
  });
  await expect(page.locator('.sample-editor')).toBeVisible();
  const before = await page.evaluate(
    (id) => window.__kk.samples.get(`${id}#0`)!.channels[0].length,
    drumId,
  );

  // Select the middle half of the waveform by dragging across the canvas.
  const box = (await page.locator('.sample-editor canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  await page.locator('.sample-editor button', { hasText: 'Trim' }).click();
  await page.locator('.sample-editor button', { hasText: 'Save' }).click();

  const after = await page.evaluate(
    (id) => window.__kk.samples.get(`${id}#0`)!.channels[0].length,
    drumId,
  );
  expect(after).toBeLessThan(before * 0.6);
  expect(after).toBeGreaterThan(before * 0.4);
});

test('loop points survive save and project round-trip', async ({ page }) => {
  const samplerId = await openEditorOnSampler(page);

  // Select a region, set the loop from it, save.
  const box = (await page.locator('.sample-editor canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.locator('.sample-editor button', { hasText: 'Set Loop' }).click();
  await page.locator('.sample-editor button', { hasText: 'Save' }).click();

  const loop = await page.evaluate((id) => {
    const s = window.__kk.samples.get(id)!;
    return { start: s.loopStart, end: s.loopEnd };
  }, samplerId);
  expect(loop.start).toBeGreaterThan(0);
  expect(loop.end).toBeGreaterThan(loop.start!);

  // Loop metadata rides through save/load.
  const restored = await page.evaluate((id) => {
    const s = window.__kk;
    s.loadProject(s.serializeWithSamples());
    const smp = s.samples.get(id)!;
    return { start: smp.loopStart, end: smp.loopEnd };
  }, samplerId);
  expect(restored.start).toBe(loop.start);
  expect(restored.end).toBe(loop.end);
});
