import { expect, test } from '@playwright/test';
import { bootWithAudio, captureErrors, classicRig, play, settleFrames } from './util';

// Phase 6 polish: per-container display controls, no-WebGPU fallback tier,
// off-screen culling (VISUALIZER_ENGINE_PLAN.md).

/** Wired visualizer module, panned to the viewport center. */
async function visOnScreen(page: import('@playwright/test').Page, synth: string): Promise<string> {
  const visId = await page.evaluate((synthId) => {
    const s = window.__kk;
    const vis = s.addModule('visualizer', 600, 500);
    s.connect({ moduleId: synthId, portId: 'out' }, { moduleId: vis.id, portId: 'in' });
    return vis.id;
  }, synth);
  await page.evaluate((id) => {
    const c = window.__kkCanvas;
    const p = c.clientPointFor(id);
    if (p) c.panBy(400 - p.x, 300 - p.y);
  }, visId);
  return visId;
}

test('rate + resolution controls write module data, scale the canvas, undo', async ({ page }) => {
  const errors = captureErrors(page);
  await bootWithAudio(page);
  const rig = await classicRig(page);
  const visId = await visOnScreen(page, rig.synth);
  await play(page);

  await page.evaluate((id) => window.__kk.openVisualizer(id), visId);
  await expect(page.locator('.vis-overlay')).toBeVisible();
  const rate = page.locator('.vis-overlay select[title="Frame rate cap"]');
  const res = page.locator('.vis-overlay select[title="Resolution scale"]');
  await expect(rate).toHaveValue('60');
  await expect(res).toHaveValue('1');

  const gpu = await page.evaluate(() => 'gpu' in navigator);
  const backing = () =>
    page.evaluate(() => {
      const c = document.querySelector('.vis-overlay canvas') as HTMLCanvasElement;
      return c.clientWidth > 0 ? c.width / c.clientWidth : 0;
    });
  // Wait for the first sized frame so the before/after ratio is meaningful.
  await expect.poll(backing, { timeout: 5000 }).toBeGreaterThan(0);
  const fullRes = await backing();

  await rate.selectOption('120');
  await res.selectOption('0.5');
  expect(
    await page.evaluate((id) => {
      const d = window.__kk.graph.modules.get(id)!.data!;
      return { fps: d.fps, res: d.res };
    }, visId),
  ).toEqual({ fps: 120, res: 0.5 });
  if (gpu) {
    // Half resolution scale halves the backing store relative to CSS size.
    await expect.poll(backing, { timeout: 5000 }).toBeLessThan(fullRes * 0.7);
  }

  // Both control changes are undoable; the selects track the data.
  await page.evaluate(() => {
    window.__kk.undo();
    window.__kk.undo();
  });
  await expect(rate).toHaveValue('60');
  await expect(res).toHaveValue('1');

  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__kk.visGpuErrors())).toBe(0);
});

test('no-WebGPU tier: approximation renders with a notice, GPU runtime idle', async ({ page }) => {
  const errors = captureErrors(page);
  // Simulate a browser without WebGPU before the app boots.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { get: () => undefined });
  });
  await bootWithAudio(page);
  const rig = await classicRig(page);
  const visId = await visOnScreen(page, rig.synth);
  await play(page);

  await page.evaluate((id) => window.__kk.openVisualizer(id), visId);
  await expect(page.locator('.vis-overlay')).toBeVisible();
  await expect(page.locator('.vis-overlay .vis-note')).toBeVisible();

  // The 2D approximation runs off live features — analysis must still flow.
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const f = window.__kk.visFeatures(id);
          return f ? f.peak : 0;
        }, visId),
      { timeout: 5000 },
    )
    .toBeGreaterThan(0.01);
  await settleFrames(page, 10);
  // No GPU device, no GPU frames.
  expect(await page.evaluate(() => window.__kk.visFramesRendered())).toBe(0);
  expect(errors).toEqual([]);
});

test('off-screen visualizer tiles are culled (GPU frame counter stalls)', async ({ page }) => {
  const errors = captureErrors(page);
  await bootWithAudio(page);
  const rig = await classicRig(page);
  const gpu = await page.evaluate(() => 'gpu' in navigator);
  test.skip(!gpu, 'WebGPU unavailable — tile thumbnails use the 2D fallback');

  const visId = await visOnScreen(page, rig.synth);
  await play(page);

  // On screen: the ¼-rate tile thumbnail advances the frame counter.
  await expect
    .poll(() => page.evaluate(() => window.__kk.visFramesRendered()), { timeout: 10000 })
    .toBeGreaterThan(0);

  // Far off screen: the counter must settle completely.
  await page.evaluate(() => window.__kkCanvas.panBy(50000, 50000));
  await settleFrames(page, 10); // drain frames already scheduled
  const parked = await page.evaluate(() => window.__kk.visFramesRendered());
  await settleFrames(page, 20);
  expect(await page.evaluate(() => window.__kk.visFramesRendered())).toBe(parked);

  // Back on screen: rendering resumes.
  await page.evaluate((id) => {
    const c = window.__kkCanvas;
    const p = c.clientPointFor(id);
    if (p) c.panBy(400 - p.x, 300 - p.y);
  }, visId);
  await expect
    .poll(() => page.evaluate(() => window.__kk.visFramesRendered()), { timeout: 10000 })
    .toBeGreaterThan(parked);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__kk.visGpuErrors())).toBe(0);
});

test('input-pole rail: drag a container input onto a node port', async ({ page }) => {
  const errors = captureErrors(page);
  await bootWithAudio(page);
  const visId = await page.evaluate(() => window.__kk.addModule('visualizer', 600, 500).id);
  await page.evaluate((id) => {
    const c = window.__kkCanvas;
    const p = c.clientPointFor(id);
    if (p) c.panBy(500 - p.x, 350 - p.y);
    window.__kk.openVisEditor(id);
  }, visId);
  await expect(page.locator('.vised')).toBeVisible();
  await expect(page.locator('.vised .pole-port')).toHaveCount(7);

  // Drag the Bass pole onto the showcase blend node's Mix in-port. The drop
  // must wire it through the existing Features presenter node.
  const bass = await page.locator('.vised [data-pole="bass"]').boundingBox();
  const gain = await page.locator('.vised [data-node="mixa"][data-port="mix"]').boundingBox();
  expect(bass && gain).toBeTruthy();
  await page.mouse.move(bass!.x + bass!.width / 2, bass!.y + bass!.height / 2);
  await page.mouse.down();
  await page.mouse.move(gain!.x + gain!.width / 2, gain!.y + gain!.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect
    .poll(() =>
      page.evaluate((id) => {
        const g = window.__kk.graph.modules.get(id)!.data!.graph as {
          nodes: { id: string; type: string }[];
          wires: { from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string } }[];
        };
        const feat = g.nodes.find((n) => n.type === 'features');
        return !!feat && g.wires.some(
          (w) => w.from.nodeId === feat.id && w.from.portId === 'bass'
            && w.to.nodeId === 'mixa' && w.to.portId === 'mix',
        );
      }, visId),
    )
    .toBe(true);

  // Second rail drag reuses the same Features node (Mod pole → mix replaces fan-in).
  const mod = await page.locator('.vised [data-pole="ctrl"]').boundingBox();
  const gain2 = await page.locator('.vised [data-node="mixa"][data-port="mix"]').boundingBox();
  await page.mouse.move(mod!.x + 3, mod!.y + 3);
  await page.mouse.down();
  await page.mouse.move(gain2!.x + 3, gain2!.y + 3, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const g = window.__kk.graph.modules.get(id)!.data!.graph as {
          nodes: { type: string }[];
          wires: { from: { portId: string }; to: { nodeId: string; portId: string } }[];
        };
        return {
          featureNodes: g.nodes.filter((n) => n.type === 'features').length,
          gainWires: g.wires.filter((w) => w.to.nodeId === 'mixa' && w.to.portId === 'mix').map((w) => w.from.portId),
        };
      }, visId),
    )
    .toEqual({ featureNodes: 1, gainWires: ['ctrl'] });
  expect(errors).toEqual([]);
});
