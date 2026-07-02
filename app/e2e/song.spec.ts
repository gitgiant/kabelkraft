import { test, expect, type Page } from '@playwright/test';
import { bootWithAudio, classicRig, pollPeak, pollPeakBelow, settleFrames } from './util';

/**
 * Song layer (SONG_PLAN.md phase 3): worklet SongPlayer plays placed clips
 * straight at their target modules; PAT/SONG mode gates playlist vs the
 * free-loop layer (sequencer/composer stepping).
 */

/** Place a dense 8-beat clip (a note every half beat) targeting `target`. */
async function placeDenseClip(page: Page, target: string): Promise<void> {
  await page.evaluate((t) => {
    const s = window.__kk;
    const notes = Array.from({ length: 16 }, (_, i) => ({ start: i / 2, pitch: 60, length: 0.4 }));
    const clip = s.addSongClip({ name: 'e2e', notes, length: 8, target: t });
    s.placeSongClip(clip.id, 0, 0);
  }, target);
}

test('SONG mode plays a placed clip at its target', async ({ page }) => {
  await bootWithAudio(page);
  const rig = await classicRig(page);
  await placeDenseClip(page, rig.voice);
  await page.evaluate(() => {
    window.__kk.setSongMode('song');
    window.__kk.transportCommand('play');
  });
  await pollPeak(page, rig.synth);
});

test('PAT mode silences the playlist; SONG silences the sequencer', async ({ page }) => {
  await bootWithAudio(page);
  const rig = await classicRig(page);

  // SONG with an EMPTY playlist: the wired sequencer must stay quiet.
  await page.evaluate(() => {
    window.__kk.setSongMode('song');
    window.__kk.transportCommand('play');
  });
  await settleFrames(page, 30);
  await pollPeakBelow(page, rig.synth, 0.01);

  // Flip to PAT: the sequencer's default pattern sounds.
  await page.evaluate(() => window.__kk.setSongMode('pat'));
  await pollPeak(page, rig.synth);

  // Back to SONG (still empty): the layer mutes again.
  await page.evaluate(() => window.__kk.setSongMode('song'));
  await pollPeakBelow(page, rig.synth, 0.01);
});

test('live keyboard input stays audible in SONG mode', async ({ page }) => {
  await bootWithAudio(page);
  const rig = await classicRig(page);
  await page.evaluate(() => {
    window.__kk.setSongMode('song');
    window.__kk.transportCommand('play');
  });
  await settleFrames(page, 10);
  await page.evaluate((kb) => window.__kk.noteOn(kb, 1, 64, 0.9), rig.keyboard);
  await pollPeak(page, rig.synth);
  await page.evaluate((kb) => window.__kk.noteOff(kb, 1), rig.keyboard);
});

test('ruler loop region wraps the transport in SONG mode', async ({ page }) => {
  await bootWithAudio(page);
  const rig = await classicRig(page);
  await placeDenseClip(page, rig.voice);
  await page.evaluate(() => {
    window.__kk.setSongMode('song');
    window.__kk.setSongLoop({ start: 0, end: 4 });
    window.__kk.transportCommand('play');
  });
  // 4 beats at 120 BPM = 2 s. Poll until the clock has demonstrably run past
  // one full loop's worth of wall time, asserting the position never escapes.
  await pollPeak(page, rig.synth);
  const start = Date.now();
  await expect
    .poll(
      async () => {
        const pos = await page.evaluate(() => window.__kk.transport.songPosition);
        if (pos >= 4) throw new Error(`songPosition escaped the loop: ${pos}`);
        return Date.now() - start;
      },
      { timeout: 10000 },
    )
    .toBeGreaterThan(3000);
  // Still sounding on later passes (notes re-fire after each wrap).
  await pollPeak(page, rig.synth);
});

test('song survives save/load round-trip and still plays', async ({ page }) => {
  await bootWithAudio(page);
  const rig = await classicRig(page);
  await placeDenseClip(page, rig.voice);
  await page.evaluate(() => window.__kk.setSongMode('song'));
  const counts = await page.evaluate(() => {
    const s = window.__kk;
    s.loadProject(s.serializeWithSamples());
    return {
      clips: s.song.clips.length,
      placements: s.song.placements.length,
      mode: s.song.mode,
    };
  });
  expect(counts).toEqual({ clips: 1, placements: 1, mode: 'song' });
  // The reloaded voice module has a new id only if ids changed — they don't
  // (deserialize preserves ids), so the clip target still resolves and plays.
  await page.evaluate(() => window.__kk.transportCommand('play'));
  await pollPeak(page, rig.synth);
});
