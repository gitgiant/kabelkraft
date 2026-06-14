import { expect, test, type Page } from '@playwright/test';
import {
  bootWithAudio,
  captureErrors,
  classicRig,
  peakOf,
  pollControl,
  pollPeak,
  pollPeakBelow,
  pollPeakUntil,
  settleFrames,
} from './util';

/**
 * Build-your-own-synth components (Voice/Osc/Filter/Amp + poly lanes) and
 * controller modules (Knob/Slider/XY/Button) — PRD §8.2/§8.6.
 */

async function start(page: Page): Promise<void> {
  await bootWithAudio(page);
  // Classic flat rig (the shipping starter's group tile would overlap test
  // placements), silenced so meters reflect only what each test builds.
  await classicRig(page);
  await page.evaluate(() => {
    const s = window.__kk;
    for (const w of [...s.graph.wires.values()]) s.disconnect(w.id);
  });
}

test('voice→osc→filter→amp chain plays polyphonically and releases', async ({ page }) => {
  const errors = captureErrors(page);
  await start(page);

  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const kb = [...s.graph.modules.values()].find((m) => m.type === 'keyboard')!;
    const out = [...s.graph.modules.values()].find((m) => m.type === 'audioOut')!;
    const voice = s.addModule('voice', 0, 0);
    const osc = s.addModule('osc', 200, 0);
    const vcf = s.addModule('vcf', 400, 0);
    const vca = s.addModule('vca', 600, 0);
    const adsr = s.addModule('envelope', 400, 200);
    s.connect({ moduleId: kb.id, portId: 'notes' }, { moduleId: voice.id, portId: 'notes' });
    s.connect({ moduleId: voice.id, portId: 'pitch' }, { moduleId: osc.id, portId: 'pitch' });
    s.connect({ moduleId: osc.id, portId: 'out' }, { moduleId: vcf.id, portId: 'in' });
    s.connect({ moduleId: vcf.id, portId: 'out' }, { moduleId: vca.id, portId: 'in' });
    s.connect({ moduleId: voice.id, portId: 'gate' }, { moduleId: adsr.id, portId: 'gate' });
    s.connect({ moduleId: adsr.id, portId: 'out' }, { moduleId: vca.id, portId: 'cv' });
    s.connect({ moduleId: vca.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
    s.setParam(adsr.id, 'release', 0.05);
    return { kb: kb.id, vca: vca.id };
  });

  // Hold a two-note chord: per-voice lanes must both sound.
  await page.evaluate((i) => {
    window.__kk.noteOn(i.kb, 'e2e-c1', 60);
    window.__kk.noteOn(i.kb, 'e2e-c2', 67);
  }, ids);
  await pollPeak(page, ids.vca);

  // Releasing both notes closes the per-voice envelopes → silence (the peak
  // meter decays between status posts, so polling rides out the release tail).
  await page.evaluate((i) => {
    window.__kk.noteOff(i.kb, 'e2e-c1');
    window.__kk.noteOff(i.kb, 'e2e-c2');
  }, ids);
  await pollPeakBelow(page, ids.vca, 0.01);

  expect(errors).toEqual([]);
});

test('unwired-pitch osc free-runs at C4 and the filter mod input shifts cutoff', async ({ page }) => {
  await start(page);
  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const out = [...s.graph.modules.values()].find((m) => m.type === 'audioOut')!;
    const osc = s.addModule('osc', 0, 0);
    const vcf = s.addModule('vcf', 200, 0);
    const knob = s.addModule('knob', 0, 200);
    s.connect({ moduleId: osc.id, portId: 'out' }, { moduleId: vcf.id, portId: 'in' });
    s.connect({ moduleId: vcf.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
    s.connect({ moduleId: knob.id, portId: 'out' }, { moduleId: vcf.id, portId: 'mod' });
    s.setParam(vcf.id, 'cutoff', 200);
    s.setParam(vcf.id, 'amt', 6);
    s.setParam(knob.id, 'value', 0);
    return { osc: osc.id, vcf: vcf.id, knob: knob.id };
  });

  await pollPeak(page, ids.vcf, 0.001);
  const closed = await peakOf(page, ids.vcf);

  await page.evaluate((i) => window.__kk.setParam(i.knob, 'value', 1), ids);
  await pollControl(page, ids.knob).toBeGreaterThan(0.99);
  // +6 octaves of cutoff on a saw passes much more energy — poll the relation.
  await pollPeakUntil(page, ids.vcf, (peak) => peak > closed * 1.5);
});

test('controllers report live values; quantizer snaps a knob to C major', async ({ page }) => {
  await start(page);
  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const knob = s.addModule('knob', 0, 0);
    const xy = s.addModule('xy', 200, 0);
    const button = s.addModule('button', 400, 0);
    const quant = s.addModule('quantizer', 0, 200);
    s.connect({ moduleId: knob.id, portId: 'out' }, { moduleId: quant.id, portId: 'in' });
    s.setParam(knob.id, 'value', 61 / 127); // C#4 → must snap to C4 (major, root C)
    s.setParam(quant.id, 'scale', 1);
    s.setParam(quant.id, 'root', 0);
    s.setParam(xy.id, 'x', 0.25);
    s.setParam(button.id, 'mode', 1);
    s.setParam(button.id, 'value', 1);
    return { knob: knob.id, xy: xy.id, button: button.id, quant: quant.id };
  });

  await pollControl(page, ids.knob).toBeCloseTo(61 / 127, 3);
  await pollControl(page, ids.quant).toBeCloseTo(60 / 127, 3);
  await pollControl(page, ids.xy).toBeCloseTo(0.25, 3);
  await pollControl(page, ids.button).toBe(1);
});

test('sample & hold captures on a button edge; slew glides between values', async ({ page }) => {
  await start(page);
  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const knob = s.addModule('knob', 0, 0);
    const button = s.addModule('button', 200, 0);
    const sah = s.addModule('sah', 400, 0);
    const slew = s.addModule('slew', 600, 0);
    s.connect({ moduleId: knob.id, portId: 'out' }, { moduleId: sah.id, portId: 'in' });
    s.connect({ moduleId: button.id, portId: 'out' }, { moduleId: sah.id, portId: 'trig' });
    s.connect({ moduleId: sah.id, portId: 'out' }, { moduleId: slew.id, portId: 'in' });
    s.setParam(button.id, 'mode', 1);
    s.setParam(knob.id, 'value', 0.8);
    s.setParam(slew.id, 'rise', 0.3);
    return { knob: knob.id, button: button.id, sah: sah.id, slew: slew.id };
  });

  // No trigger yet → held value stays 0.
  await pollControl(page, ids.sah).toBe(0);

  // Rising edge captures 0.8; the slew output follows behind, then settles.
  await page.evaluate((i) => window.__kk.setParam(i.button, 'value', 1), ids);
  await pollControl(page, ids.sah).toBeCloseTo(0.8, 3);
  await pollControl(page, ids.slew).toBeGreaterThan(0.75);

  // Knob moves later do NOT change the held value until the next edge: once
  // the knob's new value is live, the held output must still read ~0.8.
  await page.evaluate((i) => window.__kk.setParam(i.knob, 'value', 0.2), ids);
  await pollControl(page, ids.knob).toBeLessThan(0.25);
  const held = await page.evaluate((i) => window.__kk.controlValues[i.sah], ids);
  expect(held).toBeGreaterThan(0.75);
});

test('knob and XY faces respond to canvas pointer drags', async ({ page }) => {
  await start(page);
  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const knob = s.addModule('knob', -200, -100);
    const xy = s.addModule('xy', 100, -100);
    s.setParam(knob.id, 'value', 0.5);
    return { knob: knob.id, xy: xy.id };
  });
  await settleFrames(page);

  // The knob's rotary is its (only) param widget — anchor via the param
  // hit-test hook rather than offsets from the tile center.
  const knobPt = await page.evaluate(
    (i) => window.__kkCanvas.clientPointForParam(i.knob, 'value') ?? window.__kkCanvas.clientPointFor(i.knob),
    ids,
  );
  await page.mouse.move(knobPt!.x, knobPt!.y + 5);
  await page.mouse.down();
  await page.mouse.move(knobPt!.x, knobPt!.y - 55, { steps: 5 });
  await page.mouse.up();
  const v = await page.evaluate((i) => window.__kk.graph.modules.get(i.knob)!.params.value, ids);
  expect(v).toBeGreaterThan(0.5);

  // XY pad (190×210, pad spans x 18–172 / y 32–176): click near top-right.
  const xyPt = await page.evaluate((i) => window.__kkCanvas.clientPointFor(i.xy), ids);
  await page.mouse.click(xyPt!.x + 60, xyPt!.y - 55);
  const xv = await page.evaluate((i) => window.__kk.graph.modules.get(i.xy)!.params.x, ids);
  const yv = await page.evaluate((i) => window.__kk.graph.modules.get(i.xy)!.params.y, ids);
  expect(xv).toBeGreaterThan(0.6);
  expect(yv).toBeGreaterThan(0.6);
});
