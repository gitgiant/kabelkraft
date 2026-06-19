import { expect, test } from '@playwright/test';
import { bootWithAudio, classicRig, play, settleFrames } from './util';

/**
 * Modulation visualization: when an LFO drives the VCF cutoff (classicRig wires
 * lfo.out → vcf.mod), the worklet reports the effective cutoff as
 * modVals[vcf].cutoff = [cur, lo, hi]. This is the data that animates the knob
 * arc+pointer and the live filter curve. Poll state per repo convention — the
 * rendered knob is not pixel-asserted.
 */
test('LFO→VCF cutoff reports a varying effective value with a lo<hi range', async ({ page }) => {
  await bootWithAudio(page);
  const rig = await classicRig(page);

  // Non-zero filter mod amount so the cutoff actually sweeps; fast LFO so the
  // value visibly varies within the sampling window.
  await page.evaluate((r) => {
    window.__kk.setParam(r.vcf, 'amt', 5);
    window.__kk.setParam(r.lfo, 'rate', 6);
  }, rig);
  await play(page);

  // The mod input is wired → the worklet must report cutoff for the VCF.
  await expect
    .poll(() => page.evaluate((id) => !!window.__kk.modVals[id]?.cutoff, rig.vcf))
    .toBe(true);

  // Range is well-formed: lo strictly below hi (amt ≠ 0).
  const tuple = await page.evaluate(
    (id) => window.__kk.modVals[id].cutoff,
    rig.vcf,
  );
  expect(tuple[1]).toBeLessThan(tuple[2]);
  expect(tuple[0]).toBeGreaterThanOrEqual(tuple[1]);
  expect(tuple[0]).toBeLessThanOrEqual(tuple[2]);

  // The live value moves as the LFO runs (sample across several status posts).
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    samples.push(
      await page.evaluate((id) => window.__kk.modVals[id]?.cutoff?.[0] ?? -1, rig.vcf),
    );
    await settleFrames(page, 6);
  }
  expect(new Set(samples).size).toBeGreaterThan(1);

  // modVersion advances with each status post (gates the ~30Hz redraw).
  const v0 = await page.evaluate(() => window.__kk.modVersion);
  await settleFrames(page, 12);
  const v1 = await page.evaluate(() => window.__kk.modVersion);
  expect(v1).toBeGreaterThan(v0);
});
