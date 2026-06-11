import { expect, test } from '@playwright/test';
import { bootWithAudio, play, pollPeak } from './util';

/**
 * Drums are now built from components: a Composer (piano-roll rows = drum map)
 * fans out to Sample Voices (smpl), each firing only on its trigNote.
 */

const click = () => {
  const pcm = new Float32Array(4410);
  for (let i = 0; i < 100; i++) pcm[i] = 0.5;
  return pcm;
};

test('drum kit: composer drives sample voices to the output', async ({ page }) => {
  await bootWithAudio(page);

  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const out = [...s.graph.modules.values()].find((m) => m.type === 'audioOut')!;
    const comp = s.addModule('composer', -300, 700);
    // Kick on every beat (pitch 36), snare on the off-beats (pitch 37).
    s.setModuleData(comp.id, 'notes', [
      { start: 0, length: 0.1, pitch: 36, vel: 0.9 },
      { start: 1, length: 0.1, pitch: 37, vel: 0.8 },
      { start: 2, length: 0.1, pitch: 36, vel: 0.9 },
      { start: 3, length: 0.1, pitch: 37, vel: 0.8 },
    ]);
    s.setModuleData(comp.id, 'length', 4);

    const mk = (y: number, note: number) => {
      const v = s.addModule('smpl', 0, y);
      s.setParam(v.id, 'trigNote', note);
      s.setParam(v.id, 'fixedPitch', 1);
      s.setParam(v.id, 'voices', 1);
      // ~100 ms sustained tone: a 2 ms click is too short to reliably land on
      // the ~30 Hz peak meter, making the assertion flaky.
      const pcm = new Float32Array(4410);
      for (let i = 0; i < pcm.length; i++) pcm[i] = 0.5;
      s.setSample(v.id, { name: `n${note}.wav`, sampleRate: 44100, channels: [pcm] });
      s.connect({ moduleId: comp.id, portId: 'notes' }, { moduleId: v.id, portId: 'notes' });
      s.connect({ moduleId: v.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
      return v.id;
    };
    return { kick: mk(700, 36), snare: mk(850, 37), out: out.id };
  });

  await play(page);
  await pollPeak(page, ids.out);
});

test('sample voice: PCM is keyed by module id and survives save/load + undo', async ({ page }) => {
  await bootWithAudio(page);

  const smplId = await page.evaluate((pcm) => {
    const s = window.__kk;
    const v = s.addModule('smpl', 0, 700);
    s.setSample(v.id, { name: 'click.wav', sampleRate: 44100, channels: [Float32Array.from(pcm)] });
    return v.id;
  }, Array.from(click()));

  const roundTrip = await page.evaluate((id) => {
    const s = window.__kk;
    const json = s.serializeWithSamples();
    const parsed = JSON.parse(json);
    const entries = (parsed.samples ?? []).filter(
      (e: { moduleId: string; pad?: number }) => e.moduleId === id && e.pad === undefined,
    );
    s.loadProject(json);
    return { entries: entries.length, restoredName: s.samples.get(id)?.name };
  }, smplId);
  expect(roundTrip.entries).toBe(1);
  expect(roundTrip.restoredName).toBe('click.wav');

  const undoRedo = await page.evaluate((id) => {
    const s = window.__kk;
    s.select({ moduleId: id });
    s.deleteSelection();
    const gone = !s.graph.modules.has(id);
    s.undo();
    return { gone, back: s.graph.modules.has(id), sampleKept: s.samples.has(id) };
  }, smplId);
  expect(undoRedo.gone).toBe(true);
  expect(undoRedo.back).toBe(true);
  expect(undoRedo.sampleKept).toBe(true);
});
