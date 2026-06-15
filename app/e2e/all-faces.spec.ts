import { test, expect } from '@playwright/test';
import { boot, captureErrors, clearPatch, settleFrames } from './util';

/*
 * Net for the FaceRenderer refactor: every registry module type must mount a
 * tile face without throwing. Each type's face is built eagerly in the
 * ModuleView constructor (rebuild -> buildFace), so a mounted view with >0
 * children proves the face rendered. Most of the bespoke faces (pluck,
 * resonator, addosc, granular, transport, keyboard, audioIn/Out, midiIn/Out,
 * the text family) are NOT opened by any other spec — this guards them through
 * a big-bang move of buildFace/refreshParams into per-type renderers.
 *
 * Reaching into graph.defs / __kkCanvas.views mirrors how the rest of the
 * suite reaches into graph.modules / meters (see util.ts).
 */

interface FaceProbe {
  mounted: boolean;
  children: number;
}

test('every module type mounts a tile face without error', async ({ page }) => {
  const errors = captureErrors(page);
  await boot(page);
  await clearPatch(page);

  const types: string[] = await page.evaluate(() =>
    [...(window.__kk.graph as unknown as { defs: Map<string, unknown> }).defs.keys()],
  );
  expect(types.length, 'registry should expose module types').toBeGreaterThan(0);
  expect(types.length).toBe(await page.evaluate(() => window.__kkMeta.moduleDefCount));

  const failures: string[] = [];

  for (const type of types) {
    const before = errors.length;

    const id = await page.evaluate((t) => window.__kk.addModule(t, 0, 0).id, type);
    await settleFrames(page);

    const probe: FaceProbe = await page.evaluate((mid) => {
      const view = (
        window.__kkCanvas as unknown as { views: Map<string, { children: { length: number } }> }
      ).views.get(mid);
      return { mounted: !!view, children: view?.children.length ?? 0 };
    }, id);

    const newErrors = errors.slice(before);
    if (!probe.mounted) failures.push(`${type}: no tile view mounted`);
    else if (probe.children === 0) failures.push(`${type}: face built no children`);
    if (newErrors.length) failures.push(`${type}: ${newErrors.join(' | ')}`);

    await page.evaluate((mid) => window.__kk.removeModule(mid), id);
    await settleFrames(page);
  }

  expect(failures, failures.join('\n')).toEqual([]);
});
