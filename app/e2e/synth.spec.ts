import { expect, test, type Page } from '@playwright/test';

async function startWithAudio(page: Page): Promise<{ synth: string; out: string }> {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
  return page.evaluate(() => {
    const mods = [...window.__kk.graph.modules.values()];
    return {
      synth: mods.find((m) => m.type === 'synth')!.id,
      out: mods.find((m) => m.type === 'audioOut')!.id,
    };
  });
}

async function pollPeak(page: Page, id: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((i) => window.__kk.meters[i]?.peak ?? 0, id), { timeout: 5000 })
    .toBeGreaterThan(0.01);
}

test('FM mode produces audio through the starter patch', async ({ page }) => {
  const { synth } = await startWithAudio(page);
  await page.evaluate((id) => window.__kk.setParam(id, 'mode', 2), synth);
  await page.locator('.transport button[title="Play"]').click();
  await pollPeak(page, synth);

  // Output stays finite (no NaN blowup from the FM loop).
  const peak = await page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, synth);
  expect(peak).toBeLessThan(10);
});

test('wavetable mode plays the built-in table and scans position', async ({ page }) => {
  const { synth } = await startWithAudio(page);
  await page.evaluate((id) => {
    const s = window.__kk;
    s.setParam(id, 'mode', 1);
    s.setParam(id, 'wtPos', 0.7);
  }, synth);
  await page.locator('.transport button[title="Play"]').click();
  await pollPeak(page, synth);
});

test('multimode filter stays stable at extreme settings', async ({ page }) => {
  const { synth } = await startWithAudio(page);
  await page.evaluate((id) => {
    const s = window.__kk;
    s.setParam(id, 'fType', 1); // LP
    s.setParam(id, 'cutoff', 60);
    s.setParam(id, 'res', 0.95);
    s.setParam(id, 'fAmt', 1);
  }, synth);
  await page.locator('.transport button[title="Play"]').click();
  await page.waitForTimeout(1500);
  const peak = await page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, synth);
  expect(Number.isFinite(peak)).toBe(true);
  expect(peak).toBeLessThan(10); // filter must not blow up
});

test('mode switching rebuilds the face without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  const { synth } = await startWithAudio(page);
  for (const mode of [1, 2, 0, 2, 1, 0]) {
    await page.evaluate(([id, m]) => window.__kk.setParam(id as string, 'mode', m as number), [synth, mode] as const);
    await page.waitForTimeout(100);
  }
  expect(errors).toEqual([]);
});

test('arpeggiator steps a held chord into the synth', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });

  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const mods = [...s.graph.modules.values()];
    const kb = mods.find((m) => m.type === 'keyboard')!;
    const synth = mods.find((m) => m.type === 'synth')!;
    // Cut the direct keyboard→synth wire; insert the arp between them.
    const direct = [...s.graph.wires.values()].find(
      (w) => w.from.moduleId === kb.id && w.to.moduleId === synth.id,
    )!;
    s.disconnect(direct.id);
    const arp = s.addModule('arp', -300, 420);
    s.connect({ moduleId: kb.id, portId: 'notes' }, { moduleId: arp.id, portId: 'notes' });
    s.connect({ moduleId: arp.id, portId: 'out' }, { moduleId: synth.id, portId: 'notes' });
    // Also silence the sequencer so the meter reflects the arp alone.
    const seq = mods.find((m) => m.type === 'sequencer')!;
    const seqWire = [...s.graph.wires.values()].find((w) => w.from.moduleId === seq.id);
    if (seqWire) s.disconnect(seqWire.id);
    return { kb: kb.id, synth: synth.id, arp: arp.id };
  });

  // Hold a chord — the arp free-runs at the master tempo, no transport needed.
  await page.evaluate((i) => {
    const s = window.__kk;
    s.noteOn(i.kb, 'e2e-1', 60);
    s.noteOn(i.kb, 'e2e-2', 64);
    s.noteOn(i.kb, 'e2e-3', 67);
  }, ids);

  await pollPeak(page, ids.synth);

  // Note flashes mark the arp as an emitting source (wire pulse plumbing).
  const flashed = await page.evaluate((i) => window.__kk.noteFlash.has(i.arp), ids);
  expect(flashed).toBe(true);
});
