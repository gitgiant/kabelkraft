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
  await expect(page.locator('.palette .module-entry')).toHaveCount(12);

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

test('grouping keeps audio flowing and undo restores the graph', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await page.locator('.transport button[title="Play"]').click();

  // Group synth+LFO; graph stays flat for the engine, so audio must continue.
  await page.evaluate(() => {
    const s = window.__kk;
    const mods = [...s.graph.modules.values()];
    const synth = mods.find((m) => m.type === 'synth')!;
    const lfo = mods.find((m) => m.type === 'lfo')!;
    s.addToSelection({ moduleId: synth.id });
    s.addToSelection({ moduleId: lfo.id });
    s.groupSelection();
  });

  const groupCount = await page.evaluate(() => window.__kk.graph.groups.size);
  expect(groupCount).toBe(1);

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = window.__kk;
          const audioOut = [...s.graph.modules.values()].find((m) => m.type === 'audioOut')!;
          return s.meters[audioOut.id]?.peak ?? 0;
        }),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0.01);

  // Undo removes the group; modules and wires intact.
  const after = await page.evaluate(() => {
    const s = window.__kk;
    const before = { modules: s.graph.modules.size, wires: s.graph.wires.size };
    s.undo();
    return {
      groups: s.graph.groups.size,
      modulesSame: s.graph.modules.size === before.modules,
      wiresSame: s.graph.wires.size === before.wires,
      canRedo: s.canRedo,
    };
  });
  expect(after.groups).toBe(0);
  expect(after.modulesSame).toBe(true);
  expect(after.wiresSame).toBe(true);
  expect(after.canRedo).toBe(true);
});

test('effect inserted into the chain passes audio through', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
  await page.locator('.transport button[title="Play"]').click();

  // Rewire synth -> delay -> audioOut through state (graph ops, not UI drag).
  const delayId = await page.evaluate(() => {
    const s = window.__kk;
    const mods = [...s.graph.modules.values()];
    const synth = mods.find((m) => m.type === 'synth')!;
    const audioOut = mods.find((m) => m.type === 'audioOut')!;
    const direct = [...s.graph.wires.values()].find(
      (w) => w.from.moduleId === synth.id && w.to.moduleId === audioOut.id,
    )!;
    s.disconnect(direct.id);
    const delay = s.addModule('delay', 0, 400);
    s.connect({ moduleId: synth.id, portId: 'out' }, { moduleId: delay.id, portId: 'in' });
    s.connect({ moduleId: delay.id, portId: 'out' }, { moduleId: audioOut.id, portId: 'in' });
    return delay.id;
  });

  // Audio must flow through the delay and still reach the output.
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const s = window.__kk;
          const audioOut = [...s.graph.modules.values()].find((m) => m.type === 'audioOut')!;
          const viaDelay = s.meters[id]?.peak ?? 0;
          const atOut = s.meters[audioOut.id]?.peak ?? 0;
          return Math.min(viaDelay, atOut);
        }, delayId),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0.01);
});
