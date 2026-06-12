import { expect, test, type Page } from '@playwright/test';
import { bootWithAudio, captureErrors, classicRig, pollPeak, pollPeakBelow } from './util';

/**
 * Classic rig with the synth routed through mixer channel 1, plus a levels
 * module on the channel-1 send pole to monitor the FX send signal.
 */
async function mixerRig(page: Page): Promise<{ mixer: string; send: string }> {
  await bootWithAudio(page);
  const rig = await classicRig(page);
  const ids = await page.evaluate(
    ({ synth, out }) => {
      const s = window.__kk;
      const direct = [...s.graph.wires.values()].find(
        (w) => w.from.moduleId === synth && w.to.moduleId === out,
      )!;
      s.disconnect(direct.id);
      const mixer = s.addModule('mixer', 480, 360);
      const sendMon = s.addModule('levels', 880, 360);
      s.connect({ moduleId: synth, portId: 'out' }, { moduleId: mixer.id, portId: 'in1' });
      s.connect({ moduleId: mixer.id, portId: 'out' }, { moduleId: out, portId: 'in' });
      s.connect({ moduleId: mixer.id, portId: 'send1' }, { moduleId: sendMon.id, portId: 'in' });
      return { mixer: mixer.id, send: sendMon.id };
    },
    { synth: rig.synth, out: rig.out },
  );
  await page.locator('.transport button[title="Play"]').click();
  return ids;
}

test('mixer strip: audio flows, channel meter reads, kill EQ silences', async ({ page }) => {
  const errors = captureErrors(page);
  const { mixer } = await mixerRig(page);

  await pollPeak(page, mixer, 0.01);

  // Pre-fader channel meter streams under "<id>:ch1".
  await expect
    .poll(
      () => page.evaluate((id) => window.__kk.meters[`${id}:ch1`]?.peak ?? 0, mixer),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0.01);

  // Full kill on all three bands silences the channel and the master out.
  await page.evaluate((id) => {
    const s = window.__kk;
    s.setParam(id, 'eqHi1', -60);
    s.setParam(id, 'eqMid1', -60);
    s.setParam(id, 'eqLo1', -60);
  }, mixer);
  await pollPeakBelow(page, mixer, 0.01);

  // Restore the EQ and engage the highpass side of the filter dial: a saw's
  // harmonics keep passing, so audio survives the sweep (filters stay stable).
  await page.evaluate((id) => {
    const s = window.__kk;
    s.setParam(id, 'eqHi1', 0);
    s.setParam(id, 'eqMid1', 0);
    s.setParam(id, 'eqLo1', 0);
    s.setParam(id, 'filt1', 0.5);
  }, mixer);
  await pollPeak(page, mixer, 0.002);
  expect(errors).toEqual([]);
});

test('send pole taps post-fader; master strip fader gates the out', async ({ page }) => {
  const { mixer, send } = await mixerRig(page);
  await pollPeak(page, mixer, 0.01);

  // Send knob down: the pole is silent.
  await pollPeakBelow(page, send, 0.001);

  await page.evaluate((id) => window.__kk.setParam(id, 'send1', 1), mixer);
  await pollPeak(page, send, 0.01);

  // Post-fader: pulling the channel fader kills the send with it.
  await page.evaluate((id) => window.__kk.setParam(id, 'lvl1', 0), mixer);
  await pollPeakBelow(page, send, 0.001);

  // Master strip fader gates the mixed output.
  await page.evaluate((id) => {
    const s = window.__kk;
    s.setParam(id, 'lvl1', 0.8);
    s.setParam(id, 'lvl5', 0);
  }, mixer);
  await pollPeakBelow(page, mixer, 0.001);
});
