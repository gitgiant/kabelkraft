import { expect, test, type Page } from '@playwright/test';
import {
  bootWithAudio,
  captureErrors,
  clearPatch,
  pollPeak,
  pollPeakBelow,
  settleFrames,
} from './util';

/**
 * Audio In capture (fake media device: Chrome's --use-file-for-fake-audio-
 * capture flag loops a 440 Hz tone fixture through getUserMedia, and
 * --use-fake-ui auto-grants the permission prompt). Patch: audioIn → levels,
 * metering the live input.
 */
async function audioInRig(page: Page): Promise<{ input: string; levels: string }> {
  await bootWithAudio(page);
  await clearPatch(page);
  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const input = s.addModule('audioIn', -300, 0);
    const levels = s.addModule('levels', 100, 0);
    s.connect({ moduleId: input.id, portId: 'out' }, { moduleId: levels.id, portId: 'in' });
    return { input: input.id, levels: levels.id };
  });
  await settleFrames(page);
  return ids;
}

test('audio in: live capture reaches the meters', async ({ page }) => {
  const errors = captureErrors(page);
  const { input, levels } = await audioInRig(page);

  // The fixture tone flows through the module and down the wire.
  await pollPeak(page, input, 0.01);
  await pollPeak(page, levels, 0.01);
  expect(errors).toEqual([]);
});

test('audio in: mute and gain control the stream', async ({ page }) => {
  const { input } = await audioInRig(page);
  await pollPeak(page, input, 0.01);

  await page.evaluate((id) => window.__kk.setParam(id, 'mute', 1), input);
  await pollPeakBelow(page, input, 0.001);

  await page.evaluate((id) => window.__kk.setParam(id, 'mute', 0), input);
  await pollPeak(page, input, 0.01);

  await page.evaluate((id) => window.__kk.setParam(id, 'gain', 0), input);
  await pollPeakBelow(page, input, 0.001);
});

test('channel pair select folds to 1-2 when the device has fewer channels', async ({ page }) => {
  const { input, levels } = await audioInRig(page);
  const out = await page.evaluate((inputId) => {
    const s = window.__kk;
    const out = s.addModule('audioOut', 100, 300);
    s.connect({ moduleId: inputId, portId: 'out' }, { moduleId: out.id, portId: 'in' });
    return out.id;
  }, input);

  // Fake capture is mono/stereo and test output is stereo: pair 3-4 has no
  // hardware channels on either side, so both modules fold back to 1-2 and
  // audio keeps flowing.
  await page.evaluate(
    ({ input, out }) => {
      window.__kk.setParam(input, 'pair', 1);
      window.__kk.setParam(out, 'pair', 1);
    },
    { input, out },
  );
  await pollPeak(page, input, 0.01);
  await pollPeak(page, levels, 0.01);
  await pollPeak(page, out, 0.01);
});

test('options audio tab lists capture devices and default input select', async ({ page }) => {
  const errors = captureErrors(page);
  await bootWithAudio(page);

  await page.locator('.options-toggle').click();
  await page.locator('.options-tabs .tab[data-tab="audio"]').click();

  const inputSelect = page.locator('select.opt-input');
  await expect(inputSelect).toBeVisible();

  // Fake-UI flag auto-grants, so the access button may disappear on its own
  // once the device refresh lands; click it only while it is still showing.
  // (No await between check and click — the button can vanish under us.)
  await page
    .locator('.opt-device-access')
    .click({ timeout: 2000 })
    .catch(() => undefined);

  await expect
    .poll(() => inputSelect.locator('option').count())
    .toBeGreaterThan(1); // "System default" + at least the fake device

  expect(errors).toEqual([]);
});
