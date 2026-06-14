import { expect, test, type Page } from '@playwright/test';
import { bootWithAudio, play, pollPeak, pollPeakBelow, stop } from './util';

/** AI MIDI popup (piano roll), wire double-click delete, double-stop panic. */

async function setupComposerRig(page: Page): Promise<{ comp: string; synth: string; voice: string }> {
  await bootWithAudio(page);
  return page.evaluate(() => {
    const s = window.__kk;
    // Clear groups too — the starter's faced group tiles would otherwise stay
    // behind as empty ghosts and swallow the wire double-clicks below.
    for (const g of [...s.graph.groups.keys()]) s.ungroup(g);
    for (const m of [...s.graph.modules.values()]) s.removeModule(m.id);
    s.addModule('transport', -200, -400);
    const comp = s.addModule('composer', -500, 0);
    const voice = s.addModule('voice', 300, 0);
    const osc = s.addModule('osc', 600, -100);
    const adsr = s.addModule('envelope', 300, 260);
    const vca = s.addModule('vca', 900, 0);
    const out = s.addModule('audioOut', 1200, 0);
    const wire = (f: string, fp: string, t: string, tp: string) =>
      s.connect({ moduleId: f, portId: fp }, { moduleId: t, portId: tp });
    wire(comp.id, 'notes', voice.id, 'notes');
    wire(voice.id, 'pitch', osc.id, 'pitch');
    wire(voice.id, 'gate', adsr.id, 'gate');
    wire(osc.id, 'out', vca.id, 'in');
    wire(adsr.id, 'out', vca.id, 'cv');
    wire(vca.id, 'out', out.id, 'in');
    return { comp: comp.id, synth: vca.id, voice: voice.id };
  });
}

test('AI MIDI popup: paste kkmidi JSON, validate, import into the composer', async ({ page }) => {
  const ids = await setupComposerRig(page);
  await page.evaluate((comp) => window.__kk.openComposer(comp), ids.comp);
  await expect(page.locator('.piano-roll')).toBeVisible();

  await page.locator('.piano-roll button', { hasText: 'AI MIDI' }).click();
  await expect(page.locator('.popup.ai-midi')).toBeVisible();

  // Invalid payload → readable errors, nothing imported.
  await page.locator('.popup.ai-midi textarea').fill('{ "kind": "kkmidi", "length": 8 }');
  await page.locator('.popup.ai-midi button.primary', { hasText: 'Import' }).click();
  await expect(page.locator('.popup.ai-midi .ai-errors')).toBeVisible();
  await expect(page.locator('.popup.ai-midi .ai-errors')).toContainText('notes');

  // Valid clip (markdown-fenced, like a chatbot reply) imports and sets length.
  const reply =
    'Here is your riff:\n```json\n' +
    JSON.stringify({
      kind: 'kkmidi',
      name: 'Bleep Riff',
      length: 12,
      notes: [
        { start: 0, length: 0.5, pitch: 60, vel: 0.9 },
        { start: 1.4, length: 0.25, pitch: 67, vel: 0.5, prob: 0.8 },
        { start: 4, length: 2, pitch: 64 },
      ],
    }) +
    '\n```';
  await page.locator('.popup.ai-midi textarea').fill(reply);
  await page.locator('.popup.ai-midi button.primary', { hasText: 'Import' }).click();
  await expect(page.locator('.popup.ai-midi .ai-success')).toBeVisible();

  const data = await page.evaluate(
    (c) => window.__kk.graph.modules.get(c)!.data as { notes: unknown[]; length: number },
    ids.comp,
  );
  expect(data.notes).toHaveLength(3);
  expect(data.length).toBe(12);

  // One undo step removes the whole import.
  await page.evaluate(() => window.__kk.undo());
  const undone = await page.evaluate(
    (c) => (window.__kk.graph.modules.get(c)!.data!.notes as unknown[]).length,
    ids.comp,
  );
  expect(undone).not.toBe(3);
});

test('double-clicking a wire deletes it', async ({ page }) => {
  const ids = await setupComposerRig(page);

  const before = await page.evaluate(() => window.__kk.graph.wires.size);
  // Pan the rig toward the view center so the voice→osc run is comfortably
  // on-screen regardless of chrome (palette, grips) eating canvas width.
  await page.evaluate(() => window.__kkCanvas.panBy(-250, 0));
  // The voice→osc wire leaves voice's first out port and lands on osc's first
  // in port; with a known port layout (y = 24 + 18) the midpoint of a roughly
  // horizontal run sits on the curve.
  const target = await page.evaluate((v) => {
    const s = window.__kk;
    const osc = [...s.graph.modules.values()].find((m) => m.type === 'osc')!;
    const rv = window.__kkCanvas.clientRectFor(v)!;
    const ro = window.__kkCanvas.clientRectFor(osc.id)!;
    return {
      x: (rv.left + rv.width + ro.left) / 2,
      yA: rv.top + 42 * rv.scale,
      yB: ro.top + 42 * ro.scale,
    };
  }, ids.voice);

  // Sample a few points along the segment — the bezier sags between ports.
  let deleted = false;
  for (const t of [0.5, 0.4, 0.6, 0.3, 0.7]) {
    const y = target.yA + (target.yB - target.yA) * t;
    await page.mouse.dblclick(target.x, y, { delay: 80 });
    deleted = (await page.evaluate(() => window.__kk.graph.wires.size)) < before;
    if (deleted) break;
  }
  expect(deleted).toBe(true);

  // Undo restores it (delete is one undoable step).
  await page.evaluate(() => window.__kk.undo());
  expect(await page.evaluate(() => window.__kk.graph.wires.size)).toBe(before);
});

test('stop pressed twice hard-kills stuck voices (panic)', async ({ page }) => {
  const ids = await setupComposerRig(page);

  await page.evaluate(({ comp }) => {
    const s = window.__kk;
    // Long sustained note + a very long release so a single stop leaves a tail.
    s.setModuleData(comp, 'notes', [
      { start: 0, length: 16, pitch: 60, vel: 1, pan: 0, release: 0.5, modX: 0, modY: 0, prob: 1 },
    ]);
    s.setModuleData(comp, 'length', 16);
    const adsr = [...s.graph.modules.values()].find((m) => m.type === 'envelope')!;
    s.setParam(adsr.id, 'sustain', 1);
    s.setParam(adsr.id, 'release', 10);
  }, ids);

  await play(page);
  await pollPeak(page, ids.synth);

  // First stop releases notes (10 s tail keeps ringing) — second stop panics.
  await stop(page);
  await stop(page);
  await pollPeakBelow(page, ids.synth, 0.005, 3000);
});
