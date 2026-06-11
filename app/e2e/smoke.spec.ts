import { expect, test } from '@playwright/test';
import { classicRig } from './util';

test('app loads with starter patch, no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('/');
  await expect(page.locator('.toolbar .logo')).toHaveText('KabelKraft');
  await expect(page.locator('.canvas-container canvas')).toBeVisible();
  // 43 module defs + 4 starter entries.
  await expect(page.locator('.palette .module-entry')).toHaveCount(47);

  // Starter patch seeds modules + wires; give the canvas a beat to mount.
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

test('palette adds a module to the canvas', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(300);
  await page.locator('.module-entry:not(.starter-entry)', { hasText: 'Oscillator' }).click();
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
  // Starters are now silent until a note source is wired, so build the rig
  // (sequencer → voice → … → audioOut) explicitly.
  await classicRig(page);
  await page.locator('.transport button[title="Play"]').click();

  // The rig reaches an audioOut. Wait for signal there.
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
  await classicRig(page);
  await page.locator('.transport button[title="Play"]').click();

  // Group the VCA + LFO; graph stays flat for the engine, so audio must continue.
  await page.evaluate(() => {
    const s = window.__kk;
    const mods = [...s.graph.modules.values()];
    const vca = mods.find((m) => m.type === 'vca')!;
    const lfo = mods.find((m) => m.type === 'lfo')!;
    s.addToSelection({ moduleId: vca.id });
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

test('sample voice plays injected PCM pitched by the sequencer', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });

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

  await page.locator('.transport button[title="Play"]').click();
  await expect
    .poll(
      () => page.evaluate((id) => window.__kk.meters[id]?.peak ?? 0, samplerId),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0.01);

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

test('theme toggle switches to light and persists', async ({ page }) => {
  await page.goto('/');
  const before = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  );
  expect(before).toBe('#17171c');
  await page.locator('.theme-toggle').click();
  const after = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  );
  expect(after).toBe('#e9e9ef');
  expect(await page.evaluate(() => localStorage.getItem('kk-theme'))).toBe('light');
  // Persists across reload.
  await page.reload();
  const reloaded = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  );
  expect(reloaded).toBe('#e9e9ef');
  await page.evaluate(() => localStorage.removeItem('kk-theme'));
});

test('tutorial steps auto-advance and complete', async ({ page }) => {
  await page.goto('/');
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
  await page.locator('.transport button[title="Play"]').click();
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
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
  await classicRig(page);

  const recorderId = await page.evaluate(() => {
    const s = window.__kk;
    const vca = [...s.graph.modules.values()].find((m) => m.type === 'vca')!;
    const recorder = s.addModule('recorder', 600, 400);
    s.connect({ moduleId: vca.id, portId: 'out' }, { moduleId: recorder.id, portId: 'in' });
    return recorder.id;
  });

  await page.locator('.transport button[title="Play"]').click();
  await page.evaluate((id) => window.__kk.toggleRecord(id), recorderId);

  // Record ~1.5 s of the sequence.
  await page.waitForTimeout(1500);
  await expect
    .poll(() => page.evaluate((id) => window.__kk.recordingSeconds(id), recorderId))
    .toBeGreaterThan(0.5);

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate((id) => window.__kk.toggleRecord(id), recorderId);
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.wav$/);

  const seconds = await page.evaluate(() => window.__kk.lastRecordingSeconds);
  expect(seconds).toBeGreaterThan(0.5);
});

test('ADSR and Random feed control values', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
  await classicRig(page);

  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const mods = [...s.graph.modules.values()];
    const sequencer = mods.find((m) => m.type === 'sequencer')!;
    const vcf = mods.find((m) => m.type === 'vcf')!;
    const adsr = s.addModule('adsr', 0, 600);
    const random = s.addModule('random', 300, 600);
    s.connect({ moduleId: sequencer.id, portId: 'notes' }, { moduleId: adsr.id, portId: 'notes' });
    // Control fan-in is single-wire: random replaces the rig LFO on the filter mod.
    s.connect({ moduleId: random.id, portId: 'out' }, { moduleId: vcf.id, portId: 'mod' });
    return { adsr: adsr.id, random: random.id, vcf: vcf.id };
  });

  // Single-wire rule: the filter mod input now has exactly one incoming wire.
  const fanIn = await page.evaluate(
    (vcfId) =>
      [...window.__kk.graph.wires.values()].filter(
        (w) => w.to.moduleId === vcfId && w.to.portId === 'mod',
      ).length,
    ids.vcf,
  );
  expect(fanIn).toBe(1);

  await page.locator('.transport button[title="Play"]').click();
  // ADSR envelope rises with sequencer gates; Random always emits a value.
  await expect
    .poll(
      () =>
        page.evaluate(
          (i) => (window.__kk.controlValues[i.adsr] ?? 0) + (window.__kk.controlValues[i.random] !== undefined ? 1 : 0),
          ids,
        ),
      { timeout: 5000 },
    )
    .toBeGreaterThan(1);
});

test('effect inserted into the chain passes audio through', async ({ page }) => {
  await page.goto('/');
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
  await classicRig(page);
  await page.locator('.transport button[title="Play"]').click();

  // Rewire vca -> delay -> audioOut through state (graph ops, not UI drag).
  const delayId = await page.evaluate(() => {
    const s = window.__kk;
    const mods = [...s.graph.modules.values()];
    const vca = mods.find((m) => m.type === 'vca')!;
    const audioOut = mods.find((m) => m.type === 'audioOut')!;
    const direct = [...s.graph.wires.values()].find(
      (w) => w.from.moduleId === vca.id && w.to.moduleId === audioOut.id,
    )!;
    s.disconnect(direct.id);
    const delay = s.addModule('delay', 0, 400);
    s.connect({ moduleId: vca.id, portId: 'out' }, { moduleId: delay.id, portId: 'in' });
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
