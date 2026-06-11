import { expect, test, type Page } from '@playwright/test';
import { bootWithAudio, classicRig } from './util';

async function startWithAudio(page: Page): Promise<void> {
  await bootWithAudio(page);
  // Specs below grab synth/keyboard/lfo by type — rebuild the classic rig.
  await classicRig(page);
}

test('MIDI In notes drive the synth (simulated device)', async ({ page }) => {
  await startWithAudio(page);

  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const mods = [...s.graph.modules.values()];
    const voice = mods.find((m) => m.type === 'voice')!;
    const vca = mods.find((m) => m.type === 'vca')!;
    const midiIn = s.addModule('midiIn', -700, 300);
    s.connect({ moduleId: midiIn.id, portId: 'notes' }, { moduleId: voice.id, portId: 'notes' });
    return { midiIn: midiIn.id, synth: vca.id };
  });

  // Note on, channel 1, C4, velocity 100.
  await page.evaluate(() => window.__kk.midi.simulateMessage('test-dev', [0x90, 60, 100]));
  await expect
    .poll(() => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, ids.synth), { timeout: 5000 })
    .toBeGreaterThan(0.01);

  await page.evaluate(() => window.__kk.midi.simulateMessage('test-dev', [0x80, 60, 0]));

  // Channel filter: set to channel 2, channel-1 notes are ignored.
  await page.evaluate((id) => window.__kk.setParam(id, 'channel', 2), ids.midiIn);
  const before = await page.evaluate(() => window.__kk.noteFlash.size);
  await page.evaluate(() => window.__kk.midi.simulateMessage('test-dev', [0x90, 64, 100]));
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => window.__kk.noteFlash.size);
  expect(after).toBe(before); // no new flash from the filtered note
});

test('MIDI In CC feeds the control output', async ({ page }) => {
  await startWithAudio(page);

  const midiInId = await page.evaluate(() => {
    const s = window.__kk;
    const vcf = [...s.graph.modules.values()].find((m) => m.type === 'vcf')!;
    const midiIn = s.addModule('midiIn', -700, 300);
    s.setParam(midiIn.id, 'cc', 74);
    // Control fan-in is single-wire: replaces the rig LFO on the filter mod.
    s.connect({ moduleId: midiIn.id, portId: 'cc' }, { moduleId: vcf.id, portId: 'mod' });
    return midiIn.id;
  });

  await page.evaluate(() => window.__kk.midi.simulateMessage('test-dev', [0xb0, 74, 127]));
  await expect
    .poll(() => page.evaluate((id) => window.__kk.controlValues[id] ?? 0, midiInId), { timeout: 5000 })
    .toBeGreaterThan(0.95);
});

test('MIDI learn maps a CC to a param and survives save/load', async ({ page }) => {
  await startWithAudio(page);

  const synthId = await page.evaluate(() => {
    const s = window.__kk;
    const vcf = [...s.graph.modules.values()].find((m) => m.type === 'vcf')!;
    s.armMidiLearn(vcf.id, 'cutoff');
    return vcf.id;
  });
  await expect(page.locator('.midi-learn')).toBeVisible();

  // First CC received maps; value applies immediately (ch 1, CC 21, max).
  await page.evaluate(() => window.__kk.midi.simulateMessage('test-dev', [0xb0, 21, 127]));
  await expect(page.locator('.midi-learn')).toBeHidden();
  const cutoff = await page.evaluate(
    (id) => window.__kk.graph.modules.get(id)!.params.cutoff,
    synthId,
  );
  expect(cutoff).toBeGreaterThan(15000); // mapped to param max

  // Mid value scales linearly-ish into the range.
  await page.evaluate(() => window.__kk.midi.simulateMessage('test-dev', [0xb0, 21, 0]));
  const low = await page.evaluate(
    (id) => window.__kk.graph.modules.get(id)!.params.cutoff,
    synthId,
  );
  expect(low).toBeLessThan(50);

  // Mapping rides the project file.
  const restored = await page.evaluate(() => {
    const s = window.__kk;
    const json = s.serializeWithSamples();
    s.loadProject(json);
    return s.midiMap.size;
  });
  expect(restored).toBe(1);
});

test('MIDI Out sends note and CC bytes (captured in sentLog)', async ({ page }) => {
  await startWithAudio(page);

  await page.evaluate(() => {
    const s = window.__kk;
    const mods = [...s.graph.modules.values()];
    const kb = mods.find((m) => m.type === 'keyboard')!;
    const lfo = mods.find((m) => m.type === 'lfo')!;
    const midiOut = s.addModule('midiOut', 600, 500);
    s.setParam(midiOut.id, 'channel', 3);
    s.connect({ moduleId: kb.id, portId: 'notes' }, { moduleId: midiOut.id, portId: 'notes' });
    s.connect({ moduleId: lfo.id, portId: 'out' }, { moduleId: midiOut.id, portId: 'cc' });
    s.noteOn(kb.id, 'e2e', 64);
  });

  // Note-on on channel 3 (0x92) lands in the sent log via the worklet round trip.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.__kk.midi.sentLog.some((m) => m.data[0] === 0x92 && m.data[1] === 64),
        ),
      { timeout: 5000 },
    )
    .toBe(true);

  await page.evaluate(() => {
    const s = window.__kk;
    const kb = [...s.graph.modules.values()].find((m) => m.type === 'keyboard')!;
    s.noteOff(kb.id, 'e2e');
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.__kk.midi.sentLog.some((m) => m.data[0] === 0x82 && m.data[1] === 64),
        ),
      { timeout: 5000 },
    )
    .toBe(true);

  // LFO movement produces CC traffic on the bus.
  await expect
    .poll(
      () => page.evaluate(() => window.__kk.midi.sentLog.filter((m) => m.data[0] === 0xb2).length),
      { timeout: 5000 },
    )
    .toBeGreaterThan(2);
});

test('MIDI clock slave adjusts tempo and starts the transport', async ({ page }) => {
  await startWithAudio(page);

  await page.evaluate(() => {
    const s = window.__kk;
    const midiIn = s.addModule('midiIn', -700, 300);
    s.setParam(midiIn.id, 'clock', 1);
  });

  // Start + a stream of ticks at 100 BPM (25 ms per tick at 24 ppqn).
  await page.evaluate(async () => {
    const s = window.__kk;
    s.midi.simulateMessage('test-dev', [0xfa]);
    for (let i = 0; i < 30; i++) {
      s.midi.simulateMessage('test-dev', [0xf8]);
      await new Promise((r) => setTimeout(r, 25));
    }
  });

  const state = await page.evaluate(() => ({
    playing: window.__kk.transport.playing,
    tempo: window.__kk.transport.tempo,
  }));
  expect(state.playing).toBe(true);
  expect(state.tempo).toBeGreaterThan(80);
  expect(state.tempo).toBeLessThan(120);

  await page.evaluate(() => window.__kk.midi.simulateMessage('test-dev', [0xfc]));
  expect(await page.evaluate(() => window.__kk.transport.playing)).toBe(false);
});
