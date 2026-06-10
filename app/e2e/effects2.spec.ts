import { expect, test, type Page } from '@playwright/test';
import { classicRig } from './util';

async function insertFx(page: Page, type: string): Promise<{ fx: string; synth: string }> {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
  const rig = await classicRig(page);
  const ids = await page.evaluate(({ fxType, synth, out }) => {
    const s = window.__kk;
    const direct = [...s.graph.wires.values()].find(
      (w) => w.from.moduleId === synth && w.to.moduleId === out,
    )!;
    s.disconnect(direct.id);
    const fx = s.addModule(fxType, 600, 400);
    s.connect({ moduleId: synth, portId: 'out' }, { moduleId: fx.id, portId: 'in' });
    s.connect({ moduleId: fx.id, portId: 'out' }, { moduleId: out, portId: 'in' });
    return { fx: fx.id, synth };
  }, { fxType: type, synth: rig.synth, out: rig.out });
  await page.locator('.transport button[title="Play"]').click();
  return ids;
}

test('parametric EQ passes audio and streams a spectrum', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  const { fx } = await insertFx(page, 'peq');

  // A drastic curve still passes audio (filters stay stable).
  await page.evaluate((id) => {
    const s = window.__kk;
    s.setParam(id, 'b2gain', 18);
    s.setParam(id, 'b3type', 3); // lo-cut at 800
    s.setParam(id, 'b6gain', -18);
  }, fx);

  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, fx), { timeout: 5000 })
    .toBeGreaterThan(0.005);

  // Live spectrum arrives: 64 bins with signal energy somewhere.
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const sp = window.__kk.spectra[id];
          return sp && sp.length === 64 ? Math.max(...sp) : -999;
        }, fx),
      { timeout: 5000 },
    )
    .toBeGreaterThan(-60);
  expect(errors).toEqual([]);
});

test('multiband compressor compresses and solos a band', async ({ page }) => {
  const { fx } = await insertFx(page, 'mbcomp');
  await page.evaluate((id) => {
    const s = window.__kk;
    s.setParam(id, 't1', -50);
    s.setParam(id, 't2', -50);
    s.setParam(id, 't3', -50);
    s.setParam(id, 'r2', 10);
  }, fx);

  await expect
    .poll(() => page.evaluate((id) => window.__kk.gainReduction[id] ?? 0, fx), { timeout: 5000 })
    .toBeGreaterThan(1);

  // Solo the mid band: audio keeps flowing.
  await page.evaluate((id) => window.__kk.setParam(id, 's2', 1), fx);
  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, fx), { timeout: 5000 })
    .toBeGreaterThan(0.005);
});

test('delay tempo-sync + ping-pong and reverb hall pass audio', async ({ page }) => {
  const { fx: delayId } = await insertFx(page, 'delay');
  await page.evaluate((id) => {
    const s = window.__kk;
    s.setParam(id, 'sync', 2); // 1/8 at the master tempo
    s.setParam(id, 'pingpong', 1);
    s.setParam(id, 'tone', 2000);
  }, delayId);
  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, delayId), { timeout: 5000 })
    .toBeGreaterThan(0.01);

  // Swap in an upgraded reverb (hall, pre-delay, cuts) behind the delay.
  const reverbOk = await page.evaluate((id) => {
    const s = window.__kk;
    const out = [...s.graph.modules.values()].find((m) => m.type === 'audioOut')!;
    const wire = [...s.graph.wires.values()].find(
      (w) => w.from.moduleId === id && w.to.moduleId === out.id,
    )!;
    s.disconnect(wire.id);
    const rev = s.addModule('reverb', 900, 400);
    s.connect({ moduleId: id, portId: 'out' }, { moduleId: rev.id, portId: 'in' });
    s.connect({ moduleId: rev.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
    s.setParam(rev.id, 'algo', 1); // hall
    s.setParam(rev.id, 'predelay', 60);
    s.setParam(rev.id, 'lowcut', 200);
    s.setParam(rev.id, 'highcut', 6000);
    s.setParam(rev.id, 'mix', 0.5);
    return rev.id;
  }, delayId);

  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, reverbOk), { timeout: 5000 })
    .toBeGreaterThan(0.01);
});
