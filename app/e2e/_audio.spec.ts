import { test, expect } from '@playwright/test';
import { bootWithAudio, settleFrames, peakOf } from './util';

test('repro: audio plays', async ({ page }) => {
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));

  await bootWithAudio(page);

  const out = await page.evaluate(() => {
    const s = window.__kk;
    const o = [...s.graph.modules.values()].find((m) => m.type === 'audioOut');
    s.transportCommand('play');
    return o?.id ?? null;
  });
  console.log('audioOut', out, 'running', await page.evaluate(() => window.__kk.engine.running));

  await settleFrames(page, 30);
  let peak = 0;
  for (let i = 0; i < 20; i++) { peak = Math.max(peak, await peakOf(page, out!)); await settleFrames(page, 5); }
  console.log('peak', peak, 'errs', errs.slice(0, 5));
  expect(peak).toBeGreaterThan(0.0001);
});

test('repro: audio after load project', async ({ page }) => {
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await bootWithAudio(page);
  const out = await page.evaluate(() => {
    const s = window.__kk;
    const json = s.serializeWithSamples();
    s.loadProject(json);
    const o = [...s.graph.modules.values()].find((m) => m.type === 'audioOut');
    s.transportCommand('play');
    return o?.id ?? null;
  });
  await settleFrames(page, 30);
  let peak = 0;
  for (let i = 0; i < 20; i++) { peak = Math.max(peak, await peakOf(page, out!)); await settleFrames(page, 5); }
  console.log('LOAD peak', peak, 'errs', errs.slice(0,5));
  expect(peak).toBeGreaterThan(0.0001);
});
