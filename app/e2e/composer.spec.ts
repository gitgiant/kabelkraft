import { expect, test, type Page } from '@playwright/test';

/** Composer piano roll: free-time clip playback, probability, editor UI. */

async function setup(page: Page): Promise<{ comp: string; synth: string }> {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
  return page.evaluate(() => {
    const s = window.__kk;
    // Clean slate: only transport + composer + synth + out.
    for (const m of [...s.graph.modules.values()]) s.removeModule(m.id);
    s.addModule('transport', -200, -400);
    const comp = s.addModule('composer', -500, 0);
    const synth = s.addModule('synth', 100, 0);
    const out = s.addModule('audioOut', 600, 0);
    s.connect({ moduleId: comp.id, portId: 'notes' }, { moduleId: synth.id, portId: 'notes' });
    s.connect({ moduleId: synth.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
    return { comp: comp.id, synth: synth.id };
  });
}

test('default clip plays; stop releases all composer voices', async ({ page }) => {
  const ids = await setup(page);

  await page.locator('.transport button[title="Play"]').click();
  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, ids.synth), { timeout: 5000 })
    .toBeGreaterThan(0.01);

  await page.locator('.transport button[title="Stop"]').click();
  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, ids.synth), { timeout: 5000 })
    .toBeLessThan(0.005);
});

test('free-time (unquantized) notes fire; probability 0 notes never fire', async ({ page }) => {
  const ids = await setup(page);

  await page.evaluate((comp) => {
    const s = window.__kk;
    // One unquantized audible note (with per-note pan/mod/release expression
    // exercising the engine path), one prob-0 note that must stay silent.
    s.setModuleData(comp, 'notes', [
      { start: 0.13, length: 3, pitch: 69, vel: 1, pan: -0.8, release: 1, modX: 0.5, modY: 0.7, prob: 1 },
      { start: 1.5, length: 3, pitch: 81, vel: 1, pan: 0, release: 0.5, modX: 0, modY: 0, prob: 0 },
    ]);
    s.setModuleData(comp, 'length', 4);
  }, ids.comp);

  await page.locator('.transport button[title="Play"]').click();
  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, ids.synth), { timeout: 5000 })
    .toBeGreaterThan(0.01);

  // Note flashes mark composer emissions; with prob 1 + prob 0 only the
  // first note repeats. Count distinct emissions over one loop (~2 s at 120).
  const fired = await page.evaluate(
    (comp) =>
      new Promise<number>((resolve) => {
        let count = 0;
        const off = window.__kk.on('graphChanged', () => undefined); // keep types happy
        off();
        const start = performance.now();
        const tick = () => {
          const flash = window.__kk.noteFlash.get(comp);
          if (flash && flash > start && flash < start + 2200) count++;
          if (performance.now() - start > 2300) resolve(count);
          else setTimeout(tick, 100);
        };
        tick();
      }),
    ids.comp,
  );
  expect(fired).toBeGreaterThan(0);
});

test('piano roll editor: open, draw a note, quantize via popup, copy/paste', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  const ids = await setup(page);

  await page.evaluate((comp) => {
    window.__kk.setModuleData(comp, 'notes', []);
    window.__kk.openComposer(comp);
  }, ids.comp);
  await expect(page.locator('.piano-roll')).toBeVisible();

  // Draw a note on the grid (click = add at snap position).
  const grid = page.locator('.piano-roll canvas.grid');
  const box = (await grid.boundingBox())!;
  await page.mouse.click(box.x + 120, box.y + box.height / 2);
  await expect
    .poll(() =>
      page.evaluate((c) => (window.__kk.graph.modules.get(c)!.data!.notes as unknown[]).length, ids.comp),
    )
    .toBe(1);

  // Drag the same row further right with snap off → unquantized note.
  await page.locator('.piano-roll select').first().selectOption('off');
  await page.mouse.click(box.x + 222, box.y + box.height / 2 - 26);
  const starts = await page.evaluate(
    (c) => (window.__kk.graph.modules.get(c)!.data!.notes as Array<{ start: number }>).map((n) => n.start),
    ids.comp,
  );
  expect(starts).toHaveLength(2);
  expect(starts.some((s) => Math.abs(s - Math.round(s * 4) / 4) > 0.01)).toBe(true);

  // Quantize all notes to 1/4 via the popup.
  await page.locator('button', { hasText: 'Quantize…' }).click();
  await expect(page.locator('.popup')).toBeVisible();
  await page.locator('.popup select').selectOption('1/4');
  await page.locator('.popup button.primary').click();
  const quantized = await page.evaluate(
    (c) => (window.__kk.graph.modules.get(c)!.data!.notes as Array<{ start: number }>).map((n) => n.start),
    ids.comp,
  );
  for (const s of quantized) expect(Math.abs(s - Math.round(s))).toBeLessThan(0.001);

  // Select all → copy → paste duplicates the notes.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect
    .poll(() =>
      page.evaluate((c) => (window.__kk.graph.modules.get(c)!.data!.notes as unknown[]).length, ids.comp),
    )
    .toBe(4);

  // Undo collapses the paste again.
  await page.keyboard.press('Control+z');
  await expect
    .poll(() =>
      page.evaluate((c) => (window.__kk.graph.modules.get(c)!.data!.notes as unknown[]).length, ids.comp),
    )
    .toBe(2);

  await page.keyboard.press('Escape');
  await expect(page.locator('.piano-roll')).toBeHidden();
  expect(errors).toEqual([]);
});

test('legacy pattern/song project data migrates to a clip on load', async ({ page }) => {
  await page.goto('/');
  const migrated = await page.evaluate(() => {
    const s = window.__kk;
    const patterns = Array.from({ length: 1 }, () =>
      Array.from({ length: 4 }, () => Array.from({ length: 16 }, () => ({ on: false, pitch: 60 }))),
    );
    patterns[0][0][0] = { on: true, pitch: 57 };
    patterns[0][0][8] = { on: true, pitch: 64 };
    const project = JSON.stringify({
      formatVersion: 1,
      name: 'legacy',
      transport: { playing: false, tempo: 120, songPosition: 0 },
      modules: [
        { id: 'mLEG', type: 'composer', x: 0, y: 0, params: {}, data: { patterns, song: [0] } },
      ],
      wires: [],
    });
    s.loadProject(project);
    const mod = [...s.graph.modules.values()].find((m) => m.type === 'composer')!;
    return mod.data;
  });
  const notes = (migrated as { notes: Array<{ start: number; pitch: number }> }).notes;
  expect(notes).toHaveLength(2);
  expect(notes[0].pitch).toBe(57);
  expect(notes[1].start).toBe(2);
});
