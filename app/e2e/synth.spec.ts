import { expect, test, type Page } from '@playwright/test';
import { classicRig, type ClassicRig } from './util';

async function startWithAudio(page: Page): Promise<ClassicRig> {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
  return classicRig(page);
}

async function pollPeak(page: Page, id: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((i) => window.__kk.meters[i]?.peak ?? 0, id), { timeout: 5000 })
    .toBeGreaterThan(0.01);
}

test('component voice chain produces audio', async ({ page }) => {
  const rig = await startWithAudio(page);
  await page.locator('.transport button[title="Play"]').click();
  await pollPeak(page, rig.synth);
  const peak = await page.evaluate((i) => window.__kk.meters[i]?.peak ?? 0, rig.synth);
  expect(peak).toBeLessThan(10);
});

test('FM: one oscillator phase-modulates another, output stays finite', async ({ page }) => {
  const rig = await startWithAudio(page);
  await page.evaluate((r) => {
    const s = window.__kk;
    const mod = s.addModule('osc', -260, 140);
    s.connect({ moduleId: r.voice, portId: 'pitch' }, { moduleId: mod.id, portId: 'pitch' });
    s.connect({ moduleId: mod.id, portId: 'out' }, { moduleId: r.osc, portId: 'fm' });
    s.setParam(r.osc, 'fmAmt', 0.6);
    s.setParam(mod.id, 'semi', 12); // modulator one octave up
  }, rig);
  await page.locator('.transport button[title="Play"]').click();
  await pollPeak(page, rig.synth);
  const peak = await page.evaluate((i) => window.__kk.meters[i]?.peak ?? 0, rig.synth);
  expect(peak).toBeLessThan(10);
});

test('filter (vcf) stays stable at extreme settings', async ({ page }) => {
  const rig = await startWithAudio(page);
  await page.evaluate((r) => {
    const s = window.__kk;
    s.setParam(r.vcf, 'mode', 0); // LP
    s.setParam(r.vcf, 'cutoff', 60);
    s.setParam(r.vcf, 'res', 0.95);
    s.setParam(r.vcf, 'amt', 6);
  }, rig);
  await page.locator('.transport button[title="Play"]').click();
  await page.waitForTimeout(1500);
  const peak = await page.evaluate((i) => window.__kk.meters[i]?.peak ?? 0, rig.synth);
  expect(Number.isFinite(peak)).toBe(true);
  expect(peak).toBeLessThan(10); // filter must not blow up
});

test('wavetable oscillator plays the built-in table and scans position', async ({ page }) => {
  const rig = await startWithAudio(page);
  const wt = await page.evaluate((r) => {
    const s = window.__kk;
    const wt = s.addModule('wtosc', -260, 280);
    s.connect({ moduleId: r.voice, portId: 'pitch' }, { moduleId: wt.id, portId: 'pitch' });
    s.connect({ moduleId: wt.id, portId: 'out' }, { moduleId: r.out, portId: 'in' });
    s.setParam(wt.id, 'wtPos', 0.7);
    return wt.id;
  }, rig);
  await page.locator('.transport button[title="Play"]').click();
  await pollPeak(page, wt);
});

test('arpeggiator steps a held chord into the voice', async ({ page }) => {
  const rig = await startWithAudio(page);
  const ids = await page.evaluate((r) => {
    const s = window.__kk;
    // Cut the direct keyboard→voice wire; insert the arp between them.
    const direct = [...s.graph.wires.values()].find(
      (w) => w.from.moduleId === r.keyboard && w.to.moduleId === r.voice,
    )!;
    s.disconnect(direct.id);
    const arp = s.addModule('arp', -560, 420);
    s.connect({ moduleId: r.keyboard, portId: 'notes' }, { moduleId: arp.id, portId: 'notes' });
    s.connect({ moduleId: arp.id, portId: 'out' }, { moduleId: r.voice, portId: 'notes' });
    // Silence the sequencer so the meter reflects the arp alone.
    const seqWire = [...s.graph.wires.values()].find((w) => w.from.moduleId === r.sequencer);
    if (seqWire) s.disconnect(seqWire.id);
    return { arp: arp.id };
  }, rig);

  // Hold a chord — the arp free-runs at the master tempo, no transport needed.
  await page.evaluate((r) => {
    const s = window.__kk;
    s.noteOn(r.keyboard, 'e2e-1', 60);
    s.noteOn(r.keyboard, 'e2e-2', 64);
    s.noteOn(r.keyboard, 'e2e-3', 67);
  }, rig);

  await pollPeak(page, rig.synth);

  const flashed = await page.evaluate((i) => window.__kk.noteFlash.has(i.arp), ids);
  expect(flashed).toBe(true);
});
