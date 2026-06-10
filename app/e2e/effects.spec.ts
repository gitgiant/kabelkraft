import { expect, test, type Page } from '@playwright/test';
import { classicRig } from './util';

async function startPlaying(page: Page): Promise<{ synth: string; out: string }> {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
  const rig = await classicRig(page);
  await page.locator('.transport button[title="Play"]').click();
  return { synth: rig.synth, out: rig.out };
}

test('new effects chained in series pass audio through', async ({ page }) => {
  const { synth, out } = await startPlaying(page);

  const lastId = await page.evaluate((i) => {
    const s = window.__kk;
    const direct = [...s.graph.wires.values()].find(
      (w) => w.from.moduleId === i.synth && w.to.moduleId === i.out,
    )!;
    s.disconnect(direct.id);
    // synth → chorus → flanger → bitcrusher → modulator (AM) → out
    let prev = i.synth;
    let y = 400;
    for (const type of ['chorus', 'flanger', 'bitcrusher', 'modulator']) {
      const fx = s.addModule(type, 600, y);
      y += 200;
      s.connect({ moduleId: prev, portId: 'out' }, { moduleId: fx.id, portId: 'in' });
      prev = fx.id;
    }
    const mods = [...s.graph.modules.values()];
    const modulator = mods.find((m) => m.type === 'modulator')!;
    s.setParam(modulator.id, 'mode', 1); // AM keeps level audible
    s.connect({ moduleId: prev, portId: 'out' }, { moduleId: i.out, portId: 'in' });
    return prev;
  }, { synth, out });

  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, lastId), { timeout: 5000 })
    .toBeGreaterThan(0.01);
});

test('compressor reduces gain and reports GR; bypass passes through', async ({ page }) => {
  const { synth, out } = await startPlaying(page);

  const compId = await page.evaluate((i) => {
    const s = window.__kk;
    const direct = [...s.graph.wires.values()].find(
      (w) => w.from.moduleId === i.synth && w.to.moduleId === i.out,
    )!;
    s.disconnect(direct.id);
    const comp = s.addModule('compressor', 600, 400);
    s.connect({ moduleId: i.synth, portId: 'out' }, { moduleId: comp.id, portId: 'in' });
    s.connect({ moduleId: comp.id, portId: 'out' }, { moduleId: i.out, portId: 'in' });
    s.setParam(comp.id, 'threshold', -40); // sequencer signal sits well above this
    s.setParam(comp.id, 'ratio', 10);
    return comp.id;
  }, { synth, out });

  await expect
    .poll(() => page.evaluate((id) => window.__kk.gainReduction[id] ?? 0, compId), { timeout: 5000 })
    .toBeGreaterThan(1);

  // Bypass: audio still flows, GR meter drops to zero.
  await page.evaluate((id) => window.__kk.setParam(id, 'bypass', 1), compId);
  await expect
    .poll(() => page.evaluate((id) => window.__kk.gainReduction[id] ?? -1, compId), { timeout: 5000 })
    .toBe(0);
  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, compId), { timeout: 5000 })
    .toBeGreaterThan(0.01);
});

test('limiter clamps output at the ceiling', async ({ page }) => {
  const { synth, out } = await startPlaying(page);

  const limId = await page.evaluate((i) => {
    const s = window.__kk;
    const direct = [...s.graph.wires.values()].find(
      (w) => w.from.moduleId === i.synth && w.to.moduleId === i.out,
    )!;
    s.disconnect(direct.id);
    const lim = s.addModule('limiter', 600, 400);
    s.connect({ moduleId: i.synth, portId: 'out' }, { moduleId: lim.id, portId: 'in' });
    s.connect({ moduleId: lim.id, portId: 'out' }, { moduleId: i.out, portId: 'in' });
    s.setParam(lim.id, 'ceiling', -24);
    s.setParam(i.synth, 'level', 1);
    return lim.id;
  }, { synth, out });

  await expect
    .poll(() => page.evaluate((id) => window.__kk.gainReduction[id] ?? 0, limId), { timeout: 5000 })
    .toBeGreaterThan(0.5);

  // Peak must respect the −24 dB ceiling (≈0.063 linear), with envelope slack.
  const peak = await page.evaluate((id) => window.__kk.meters[id]?.peak ?? 1, limId);
  expect(peak).toBeLessThan(0.15);
});
