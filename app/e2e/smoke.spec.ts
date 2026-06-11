import { expect, test } from '@playwright/test';
import {
  boot,
  bootWithAudio,
  captureErrors,
  classicRig,
  play,
  pollPeak,
  settleFrames,
} from './util';

test('app loads with starter patch, no console errors', async ({ page }) => {
  const errors = captureErrors(page);
  await boot(page);

  await expect(page.locator('.toolbar .logo')).toHaveText('KabelKraft');
  // Palette lists every module def plus the starter entries — counts come
  // from the app itself so new modules don't break this test.
  const meta = await page.evaluate(() => window.__kkMeta);
  await expect(page.locator('.palette .module-entry')).toHaveCount(
    meta.moduleDefCount + meta.starterCount,
  );

  await settleFrames(page, 10); // give async init a few frames to surface errors
  expect(errors).toEqual([]);
});

test('palette adds a module to the canvas', async ({ page }) => {
  const errors = captureErrors(page);
  await boot(page);
  const before = await page.evaluate(() => window.__kk.graph.modules.size);

  await page.locator('.module-entry:not(.starter-entry)', { hasText: 'Oscillator' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__kk.graph.modules.size))
    .toBeGreaterThan(before);

  await settleFrames(page, 5);
  expect(errors).toEqual([]);
});

test('enable audio starts the engine worklet', async ({ page }) => {
  await bootWithAudio(page);
});

test('play runs the sequencer and audio reaches the output', async ({ page }) => {
  await bootWithAudio(page);
  // Starters are silent until a note source is wired, so build the rig
  // (sequencer → voice → … → audioOut) explicitly.
  const rig = await classicRig(page);
  await play(page);

  await pollPeak(page, rig.out);

  // Song position advances while playing.
  const pos = await page.evaluate(() => window.__kk.transport.songPosition);
  expect(pos).toBeGreaterThan(0);
});

test('grouping keeps audio flowing and undo restores the graph', async ({ page }) => {
  await bootWithAudio(page);
  const rig = await classicRig(page);
  await play(page);

  // Group the VCA + LFO; graph stays flat for the engine, so audio must continue.
  await page.evaluate((r) => {
    const s = window.__kk;
    s.addToSelection({ moduleId: r.vca });
    s.addToSelection({ moduleId: r.lfo });
    s.groupSelection();
  }, rig);

  expect(await page.evaluate(() => window.__kk.graph.groups.size)).toBe(1);
  await pollPeak(page, rig.out);

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

test('sample voice plays injected PCM pitched by the sequencer', async ({ page }) => {
  await bootWithAudio(page);

  // Starters no longer ship a sequencer; build the rig for a note source + out.
  const rig = await classicRig(page);
  const samplerId = await page.evaluate(({ sequencerId, outId }) => {
    const s = window.__kk;
    const sampler = s.addModule('smpl', 0, 500);
    // 0.5 s 440 Hz sine with a fade-out tail.
    const n = 22050;
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pcm[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * (1 - i / n) * 0.8;
    }
    s.setSample(sampler.id, { name: 'test-sine.wav', sampleRate: 44100, channels: [pcm] });
    s.connect({ moduleId: sequencerId, portId: 'notes' }, { moduleId: sampler.id, portId: 'notes' });
    s.connect({ moduleId: sampler.id, portId: 'out' }, { moduleId: outId, portId: 'in' });
    return sampler.id;
  }, { sequencerId: rig.sequencer, outId: rig.out });

  await play(page);
  await pollPeak(page, samplerId);

  // Save embeds the sample; loading the saved JSON restores PCM to the store.
  const roundTrip = await page.evaluate((id) => {
    const s = window.__kk;
    const json = s.serializeWithSamples();
    const parsed = JSON.parse(json);
    const embedded = (parsed.samples ?? []).length;
    s.loadProject(json);
    const restored = s.samples.get(id);
    return {
      embedded,
      restoredName: restored?.name,
      restoredLength: restored?.channels[0]?.length ?? 0,
    };
  }, samplerId);
  expect(roundTrip.embedded).toBe(1);
  expect(roundTrip.restoredName).toBe('test-sine.wav');
  expect(roundTrip.restoredLength).toBe(22050);
});

test('theme toggle switches theme and persists', async ({ page }) => {
  await boot(page);
  const readBg = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());

  const before = await readBg();
  await page.locator('.theme-toggle').click();
  const after = await readBg();
  // Don't pin exact hex values — only that the theme actually changed and persists.
  expect(after).not.toBe(before);
  expect(await page.evaluate(() => localStorage.getItem('kk-theme'))).toBe('light');

  await page.reload();
  expect(await readBg()).toBe(after);
  await page.evaluate(() => localStorage.removeItem('kk-theme'));
});

test('tutorial steps auto-advance and complete', async ({ page }) => {
  await boot(page);
  await page.locator('button[title="Start the tutorial"]').click();
  await page.locator('button.just-start').click(); // save prompt → skip saving
  await expect(page.locator('.tutorial-title')).toHaveText('Add an Oscillator');

  // Tutorial resets to a minimal patch (transport + audioOut only).
  expect(await page.evaluate(() => window.__kk.graph.modules.size)).toBe(2);

  // Step 1: add an oscillator from the palette.
  await page.locator('.module-entry:not(.starter-entry)', { hasText: 'Oscillator' }).first().click();
  await expect(page.locator('.tutorial-title')).toHaveText('Wire the audio');

  // Step 2: wire the oscillator into the audio output.
  await page.evaluate(() => {
    const s = window.__kk;
    const mods = [...s.graph.modules.values()];
    const osc = mods.find((m) => m.type === 'osc')!;
    const out = mods.find((m) => m.type === 'audioOut')!;
    s.connect({ moduleId: osc.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
  });
  await expect(page.locator('.tutorial-title')).toHaveText('Play the drone');

  // Step 3: the unwired oscillator drones at C4 — start the transport too.
  await play(page);
  await expect(page.locator('.tutorial-title')).toHaveText('Add a Keyboard and a Voice', { timeout: 5000 });

  // Step 4: add a keyboard and a voice.
  await page.evaluate(() => {
    const s = window.__kk;
    s.addModule('keyboard', -500, 200);
    s.addModule('voice', -250, 100);
  });
  await expect(page.locator('.tutorial-title')).toHaveText('Wire notes → voice → pitch');

  // Step 5: keyboard → voice → osc pitch.
  await page.evaluate(() => {
    const s = window.__kk;
    const mods = [...s.graph.modules.values()];
    const kb = mods.find((m) => m.type === 'keyboard')!;
    const voice = mods.find((m) => m.type === 'voice')!;
    const osc = mods.find((m) => m.type === 'osc')!;
    s.connect({ moduleId: kb.id, portId: 'notes' }, { moduleId: voice.id, portId: 'notes' });
    s.connect({ moduleId: voice.id, portId: 'pitch' }, { moduleId: osc.id, portId: 'pitch' });
  });
  await expect(page.locator('.tutorial-title')).toHaveText('Modulate with an LFO');

  // Step 6: add a filter + LFO, wire the LFO to the filter's Mod input.
  await page.evaluate(() => {
    const s = window.__kk;
    const vcf = s.addModule('vcf', 0, 300);
    const lfo = s.addModule('lfo', -500, 400);
    s.connect({ moduleId: lfo.id, portId: 'out' }, { moduleId: vcf.id, portId: 'mod' });
  });
  await expect(page.locator('.tutorial-step')).toHaveText(/Tutorial complete/);
});

test('recorder captures playing audio and downloads a WAV', async ({ page }) => {
  await bootWithAudio(page);
  const rig = await classicRig(page);

  const recorderId = await page.evaluate((vcaId) => {
    const s = window.__kk;
    const recorder = s.addModule('recorder', 600, 400);
    s.connect({ moduleId: vcaId, portId: 'out' }, { moduleId: recorder.id, portId: 'in' });
    return recorder.id;
  }, rig.vca);

  await play(page);
  await page.evaluate((id) => window.__kk.toggleRecord(id), recorderId);

  // Record until well past half a second of audio is captured.
  await expect
    .poll(() => page.evaluate((id) => window.__kk.recordingSeconds(id), recorderId), {
      timeout: 5000,
    })
    .toBeGreaterThan(0.5);

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate((id) => window.__kk.toggleRecord(id), recorderId);
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.wav$/);

  const seconds = await page.evaluate(() => window.__kk.lastRecordingSeconds);
  expect(seconds).toBeGreaterThan(0.5);
});

test('ADSR and Random feed control values', async ({ page }) => {
  await bootWithAudio(page);
  const rig = await classicRig(page);

  const ids = await page.evaluate((r) => {
    const s = window.__kk;
    const adsr = s.addModule('adsr', 0, 600);
    const random = s.addModule('random', 300, 600);
    s.connect({ moduleId: r.sequencer, portId: 'notes' }, { moduleId: adsr.id, portId: 'notes' });
    // Control fan-in is single-wire: random replaces the rig LFO on the filter mod.
    s.connect({ moduleId: random.id, portId: 'out' }, { moduleId: r.vcf, portId: 'mod' });
    return { adsr: adsr.id, random: random.id };
  }, rig);

  // Single-wire rule: the filter mod input now has exactly one incoming wire.
  const fanIn = await page.evaluate(
    (vcfId) =>
      [...window.__kk.graph.wires.values()].filter(
        (w) => w.to.moduleId === vcfId && w.to.portId === 'mod',
      ).length,
    rig.vcf,
  );
  expect(fanIn).toBe(1);

  await play(page);
  // ADSR envelope rises with sequencer gates; Random always emits a value.
  await expect
    .poll(
      () =>
        page.evaluate(
          (i) =>
            (window.__kk.controlValues[i.adsr] ?? 0) +
            (window.__kk.controlValues[i.random] !== undefined ? 1 : 0),
          ids,
        ),
      { timeout: 5000 },
    )
    .toBeGreaterThan(1);
});

test('effect inserted into the chain passes audio through', async ({ page }) => {
  await bootWithAudio(page);
  const rig = await classicRig(page);
  await play(page);

  // Rewire vca -> delay -> audioOut through state (graph ops, not UI drag).
  const delayId = await page.evaluate((r) => {
    const s = window.__kk;
    const direct = [...s.graph.wires.values()].find(
      (w) => w.from.moduleId === r.vca && w.to.moduleId === r.out,
    )!;
    s.disconnect(direct.id);
    const delay = s.addModule('delay', 0, 400);
    s.connect({ moduleId: r.vca, portId: 'out' }, { moduleId: delay.id, portId: 'in' });
    s.connect({ moduleId: delay.id, portId: 'out' }, { moduleId: r.out, portId: 'in' });
    return delay.id;
  }, rig);

  // Audio must flow through the delay and still reach the output.
  await pollPeak(page, delayId);
  await pollPeak(page, rig.out);
});
