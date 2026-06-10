import { expect, test } from '@playwright/test';

test('drum machine: default kit beat reaches the output', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });

  const drumId = await page.evaluate(() => {
    const s = window.__kk;
    const audioOut = [...s.graph.modules.values()].find((m) => m.type === 'audioOut')!;
    const drum = s.addModule('drum', 0, 700);
    s.connect({ moduleId: drum.id, portId: 'out' }, { moduleId: audioOut.id, portId: 'in' });
    return drum.id;
  });

  // Default kit pads carry PCM keyed moduleId#pad.
  const kitPads = await page.evaluate(
    (id) => [...window.__kk.samples.keys()].filter((k) => k.startsWith(`${id}#`)).length,
    drumId,
  );
  expect(kitPads).toBe(8);

  // Internal step sequencer drives the default beat — no note wires needed.
  await page.locator('.transport button[title="Play"]').click();
  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, drumId), { timeout: 5000 })
    .toBeGreaterThan(0.01);

  // Playhead is reported like the sequencer's.
  await expect
    .poll(() => page.evaluate((id) => window.__kk.seqSteps[id] ?? -1, drumId), { timeout: 5000 })
    .toBeGreaterThanOrEqual(0);
});

test('drum machine: pad audition makes sound without the transport', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });

  const drumId = await page.evaluate(() => {
    const s = window.__kk;
    const audioOut = [...s.graph.modules.values()].find((m) => m.type === 'audioOut')!;
    const drum = s.addModule('drum', 0, 700);
    s.connect({ moduleId: drum.id, portId: 'out' }, { moduleId: audioOut.id, portId: 'in' });
    return drum.id;
  });

  await page.evaluate((id) => window.__kk.padTrigger(id, 0), drumId);
  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, drumId), { timeout: 5000 })
    .toBeGreaterThan(0.01);
});

test('drum machine: pad samples survive save/load and undo restore', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });

  const drumId = await page.evaluate(() => {
    const s = window.__kk;
    const drum = s.addModule('drum', 0, 700);
    // Replace pad 2 with a custom click so we can identify it after reload.
    const pcm = new Float32Array(4410).fill(0).map((_, i) => (i < 100 ? 0.5 : 0));
    s.setSample(drum.id, { name: 'click.wav', sampleRate: 44100, channels: [pcm] }, 2);
    return drum.id;
  });

  const roundTrip = await page.evaluate((id) => {
    const s = window.__kk;
    const json = s.serializeWithSamples();
    const parsed = JSON.parse(json);
    const padEntries = (parsed.samples ?? []).filter(
      (e: { moduleId: string; pad?: number }) => e.moduleId === id && e.pad !== undefined,
    );
    s.loadProject(json);
    const restored = s.samples.get(`${id}#2`);
    const pads = s.graph.modules.get(id)?.data?.pads as Array<{ name: string }>;
    return {
      padEntries: padEntries.length,
      restoredName: restored?.name,
      padName: pads?.[2]?.name,
    };
  }, drumId);
  expect(roundTrip.padEntries).toBe(8); // 7 default kit pieces + custom pad 2
  expect(roundTrip.restoredName).toBe('click.wav');
  expect(roundTrip.padName).toBe('click');

  // Undo the module add, redo it back: samples must still be in the store.
  const undoRedo = await page.evaluate((id) => {
    const s = window.__kk;
    // loadProject cleared undo history; delete + undo instead.
    s.select({ moduleId: id });
    s.deleteSelection();
    const gone = !s.graph.modules.has(id);
    s.undo();
    return { gone, back: s.graph.modules.has(id), sampleKept: s.samples.has(`${id}#2`) };
  }, drumId);
  expect(undoRedo.gone).toBe(true);
  expect(undoRedo.back).toBe(true);
  expect(undoRedo.sampleKept).toBe(true);
});
