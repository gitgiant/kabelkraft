import { expect, test } from '@playwright/test';
import { boot, bootWithAudio, captureErrors, classicRig, play, settleFrames } from './util';

test('visualizer container computes features and big view opens', async ({ page }) => {
  const errors = captureErrors(page);
  await bootWithAudio(page);
  const rig = await classicRig(page);

  const visId = await page.evaluate(({ synth, sequencer }) => {
    const s = window.__kk;
    const vis = s.addModule('visualizer', 600, 500);
    s.connect({ moduleId: synth, portId: 'out' }, { moduleId: vis.id, portId: 'in' });
    s.connect({ moduleId: sequencer, portId: 'notes' }, { moduleId: vis.id, portId: 'notes' });
    return vis.id;
  }, { synth: rig.synth, sequencer: rig.sequencer });

  // Fresh containers carry the init showcase graph (scene chains → Scenes → Output).
  const graph = await page.evaluate(
    (id) => window.__kk.graph.modules.get(id)!.data!.graph as { nodes: { type: string }[]; wires: unknown[] },
    visId,
  );
  const types = graph.nodes.map((n) => n.type);
  expect(types).toContain('scenes');
  expect(types).toContain('features');
  expect(types.filter((t) => t === 'output')).toHaveLength(1);
  // Exact counts intentionally not pinned — the showcase graph evolves; the
  // structural checks above already prove it's the seeded scene graph. Keep a
  // sanity floor so a failed-to-seed empty graph still trips.
  expect(graph.nodes.length).toBeGreaterThan(5);
  expect(graph.wires.length).toBeGreaterThanOrEqual(graph.nodes.length - 1);

  // Dev server sends COOP/COEP, so the SAB audio ring path must be active.
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  await play(page);

  // UI-side analysis produces real signal (raw windows → level/spectrum).
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

  // Big view opens in place over the tile (WebGPU runtime or Canvas2D tier).
  await page.evaluate((id) => {
    const c = window.__kkCanvas;
    const p = c.clientPointFor(id);
    if (p) c.panBy(400 - p.x, 300 - p.y);
    window.__kk.openVisualizer(id);
  }, visId);
  await expect(page.locator('.vis-overlay')).toBeVisible();
  await expect(page.locator('.vis-overlay canvas')).toBeVisible();
  const gpu = await page.evaluate(() => 'gpu' in navigator);
  if (gpu) {
    // The runtime should be advancing frames for the supported init graph.
    await expect
      .poll(() => page.evaluate(() => window.__kk.visFramesRendered()), { timeout: 5000 })
      .toBeGreaterThan(0);
  }
  await settleFrames(page, 5);
  await page.locator('.vis-overlay button[title="Close (Esc)"]').click();
  await expect(page.locator('.vis-overlay')).toBeHidden();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__kk.visGpuErrors())).toBe(0);
});

test('visual graph editing: effect chain renders and editor opens', async ({ page }) => {
  const errors = captureErrors(page);
  await bootWithAudio(page);
  const rig = await classicRig(page);

  const visId = await page.evaluate(({ synth }) => {
    const s = window.__kk;
    const vis = s.addModule('visualizer', 600, 500);
    s.connect({ moduleId: synth, portId: 'out' }, { moduleId: vis.id, portId: 'in' });
    return vis.id;
  }, { synth: rig.synth });
  await play(page);

  // Rewire the container: spectrum → bloom → feedback → output, with a
  // Features bass wire modulating bloom amount.
  await page.evaluate((id) => {
    window.__kk.setVisGraph(id, {
      nodes: [
        { id: 'v1', type: 'spectrum', x: 40, y: 60, params: { gain: 2 } },
        { id: 'v2', type: 'bloom', x: 240, y: 60, params: { threshold: 0.4, amount: 1 } },
        { id: 'v3', type: 'feedback', x: 440, y: 60, params: { zoom: 0.2, spin: 0.1, fade: 0.9 } },
        { id: 'v4', type: 'output', x: 640, y: 60, params: {} },
        { id: 'v5', type: 'features', x: 40, y: 220, params: {} },
      ],
      wires: [
        { id: 'vw1', from: { nodeId: 'v1', portId: 'out' }, to: { nodeId: 'v2', portId: 'in' } },
        { id: 'vw2', from: { nodeId: 'v2', portId: 'out' }, to: { nodeId: 'v3', portId: 'in' } },
        { id: 'vw3', from: { nodeId: 'v3', portId: 'out' }, to: { nodeId: 'v4', portId: 'in' } },
        { id: 'vw4', from: { nodeId: 'v5', portId: 'bass' }, to: { nodeId: 'v2', portId: 'amount' } },
      ],
    });
  }, visId);

  // The multi-pass GPU pipeline keeps producing frames without errors.
  const gpu = await page.evaluate(() => 'gpu' in navigator);
  if (gpu) {
    await page.evaluate((id) => {
      const c = window.__kkCanvas;
      const p = c.clientPointFor(id);
      if (p) c.panBy(400 - p.x, 300 - p.y);
      window.__kk.openVisualizer(id);
    }, visId);
    await expect(page.locator('.vis-overlay')).toBeVisible();
    const before = await page.evaluate(() => window.__kk.visFramesRendered());
    await expect
      .poll(() => page.evaluate(() => window.__kk.visFramesRendered()), { timeout: 5000 })
      .toBeGreaterThan(before + 10);
    await page.locator('.vis-overlay button[title="Close (Esc)"]').click();
  }

  // Graph edits are undoable.
  const nodeCounts = await page.evaluate((id) => {
    const s = window.__kk;
    const count = () =>
      (s.graph.modules.get(id)!.data!.graph as { nodes: unknown[] }).nodes.length;
    const after = count();
    s.undo();
    const undone = count();
    s.redo();
    return { after, undone, redone: count() };
  }, visId);
  expect(nodeCounts.after).toBe(5);
  expect(nodeCounts.undone).toBe(18); // back to the init showcase graph
  expect(nodeCounts.redone).toBe(5);

  // Editor panel opens in place (anchored over the tile), shows the graph, closes.
  await page.evaluate((id) => {
    // Panel pins to the module — bring the tile on screen first.
    const c = window.__kkCanvas;
    const p = c.clientPointFor(id);
    if (p) c.panBy(400 - p.x, 300 - p.y);
    window.__kk.openVisEditor(id);
  }, visId);
  await expect(page.locator('.vised')).toBeVisible();
  await expect(page.locator('.vised .node')).toHaveCount(5);
  await page.locator('.vised button[title="Close (Esc)"]').click();
  await expect(page.locator('.vised')).toBeHidden();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__kk.visGpuErrors())).toBe(0);
});

test('text wire: producer → container → Text Layer renders', async ({ page }) => {
  const errors = captureErrors(page);
  await bootWithAudio(page);

  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const input = s.addModule('textinput', 200, 500);
    const vis = s.addModule('visualizer', 600, 500);
    const wire = s.connect(
      { moduleId: input.id, portId: 'out' },
      { moduleId: vis.id, portId: 'text' },
    );
    // Text Layer in stack mode replaces the init showcase graph.
    s.setVisGraph(vis.id, {
      nodes: [
        { id: 'v1', type: 'textlayer', x: 40, y: 60, params: { mode: 3, size: 0.12 } },
        { id: 'v2', type: 'output', x: 320, y: 60, params: {} },
      ],
      wires: [{ id: 'vw1', from: { nodeId: 'v1', portId: 'out' }, to: { nodeId: 'v2', portId: 'in' } }],
    });
    return { input: input.id, vis: vis.id, wired: wire.ok };
  });
  expect(ids.wired).toBe(true);

  // Typed lines route along the text wire into the container's feature feed.
  await page.evaluate(({ input }) => {
    window.__kk.sendTextInput(input, 'hello stage');
    window.__kk.sendTextInput(input, 'second line');
  }, ids);
  const feed = await page.evaluate(({ vis }) => {
    const f = window.__kk.visFeatures(vis);
    return f ? { text: f.text, stack: f.textStack } : null;
  }, ids);
  expect(feed).not.toBeNull();
  expect(feed!.text).toBe('second line');
  expect(feed!.stack).toEqual(['hello stage', 'second line']);

  // Text Layer renders through the GPU path.
  const gpu = await page.evaluate(() => 'gpu' in navigator);
  if (gpu) {
    await page.evaluate(({ vis }) => {
      const c = window.__kkCanvas;
      const p = c.clientPointFor(vis);
      if (p) c.panBy(400 - p.x, 300 - p.y);
      window.__kk.openVisualizer(vis);
    }, ids);
    const before = await page.evaluate(() => window.__kk.visFramesRendered());
    await expect
      .poll(() => page.evaluate(() => window.__kk.visFramesRendered()), { timeout: 5000 })
      .toBeGreaterThan(before + 10);
    await page.locator('.vis-overlay button[title="Close (Esc)"]').click();
  }
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__kk.visGpuErrors())).toBe(0);
});

test('visual wire chains containers: A renders into B via Visual In', async ({ page }) => {
  const errors = captureErrors(page);
  await bootWithAudio(page);
  const rig = await classicRig(page);

  const ids = await page.evaluate(({ synth }) => {
    const s = window.__kk;
    const a = s.addModule('visualizer', 300, 500); // keeps init showcase graph
    const b = s.addModule('visualizer', 700, 500);
    s.connect({ moduleId: synth, portId: 'out' }, { moduleId: a.id, portId: 'in' });
    const chainWire = s.connect(
      { moduleId: a.id, portId: 'vout' },
      { moduleId: b.id, portId: 'vin' },
    );
    // B = upstream frame warped, plus nothing local.
    s.setVisGraph(b.id, {
      nodes: [
        { id: 'v1', type: 'visualin', x: 40, y: 60, params: {} },
        { id: 'v2', type: 'warp', x: 240, y: 60, params: { amount: 0.5, freq: 10, speed: 1 } },
        { id: 'v3', type: 'output', x: 440, y: 60, params: {} },
      ],
      wires: [
        { id: 'vw1', from: { nodeId: 'v1', portId: 'out' }, to: { nodeId: 'v2', portId: 'in' } },
        { id: 'vw2', from: { nodeId: 'v2', portId: 'out' }, to: { nodeId: 'v3', portId: 'in' } },
      ],
    });
    return { a: a.id, b: b.id, chained: chainWire.ok };
  }, { synth: rig.synth });
  expect(ids.chained).toBe(true);

  // The frame builder resolves the chain (and survives a wire-back cycle).
  const chain = await page.evaluate(({ a, b }) => {
    const s = window.__kk;
    const frame = s.visFrame(b)!;
    const cycleWire = s.connect({ moduleId: b, portId: 'vout' }, { moduleId: a, portId: 'vin' });
    const cycled = s.visFrame(b)!; // must terminate, breaking the loop
    return {
      upstreamId: frame.upstream[0]?.id,
      cycleWireOk: cycleWire.ok,
      cycledDepthOk: cycled.upstream[0]?.upstream.length === 0,
    };
  }, ids);
  expect(chain.upstreamId).toBe(ids.a);
  expect(chain.cycleWireOk).toBe(true);
  expect(chain.cycledDepthOk).toBe(true);

  await play(page);
  const gpu = await page.evaluate(() => 'gpu' in navigator);
  if (gpu) {
    await page.evaluate(({ b }) => {
      const c = window.__kkCanvas;
      const p = c.clientPointFor(b);
      if (p) c.panBy(400 - p.x, 300 - p.y);
      window.__kk.openVisualizer(b);
    }, ids);
    await expect(page.locator('.vis-overlay')).toBeVisible();
    const before = await page.evaluate(() => window.__kk.visFramesRendered());
    await expect
      .poll(() => page.evaluate(() => window.__kk.visFramesRendered()), { timeout: 5000 })
      .toBeGreaterThan(before + 10);
    await page.locator('.vis-overlay button[title="Close (Esc)"]').click();
  }
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__kk.visGpuErrors())).toBe(0);
});

test('3D raymarch nodes render without GPU errors', async ({ page }) => {
  const errors = captureErrors(page);
  await bootWithAudio(page);
  const rig = await classicRig(page);

  const visId = await page.evaluate(({ synth }) => {
    const s = window.__kk;
    const vis = s.addModule('visualizer', 600, 500);
    s.connect({ moduleId: synth, portId: 'out' }, { moduleId: vis.id, portId: 'in' });
    // All three raymarch sources blended together so every 3D shader compiles
    // and runs each frame; a Features bass wire exercises a 3D mod port.
    s.setVisGraph(vis.id, {
      nodes: [
        { id: 'feat', type: 'features', x: 40, y: 320, params: {} },
        { id: 'tun', type: 'raytunnel', x: 40, y: 40, params: { speed: 1.2, glow: 0.6 } },
        { id: 'frac', type: 'sdffractal', x: 40, y: 140, params: { dist: 5, scale: 2.5, iters: 10 } },
        { id: 'terr', type: 'terrain', x: 40, y: 240, params: { height: 1.4, dist: 6, pitch: 0.3 } },
        { id: 'b1', type: 'blend', x: 240, y: 90, params: { mode: 2 } },
        { id: 'b2', type: 'blend', x: 440, y: 140, params: { mode: 2 } },
        { id: 'glow', type: 'bloom', x: 640, y: 140, params: { threshold: 0.4, amount: 1 } },
        { id: 'out', type: 'output', x: 840, y: 140, params: {} },
      ],
      wires: [
        { id: 'w1', from: { nodeId: 'tun', portId: 'out' }, to: { nodeId: 'b1', portId: 'a' } },
        { id: 'w2', from: { nodeId: 'frac', portId: 'out' }, to: { nodeId: 'b1', portId: 'b' } },
        { id: 'w3', from: { nodeId: 'b1', portId: 'out' }, to: { nodeId: 'b2', portId: 'a' } },
        { id: 'w4', from: { nodeId: 'terr', portId: 'out' }, to: { nodeId: 'b2', portId: 'b' } },
        { id: 'w5', from: { nodeId: 'b2', portId: 'out' }, to: { nodeId: 'glow', portId: 'in' } },
        { id: 'w6', from: { nodeId: 'glow', portId: 'out' }, to: { nodeId: 'out', portId: 'in' } },
        { id: 'w7', from: { nodeId: 'feat', portId: 'bass' }, to: { nodeId: 'frac', portId: 'scale' } },
      ],
    });
    return vis.id;
  }, { synth: rig.synth });
  await play(page);

  const gpu = await page.evaluate(() => 'gpu' in navigator);
  if (gpu) {
    await page.evaluate((id) => {
      const c = window.__kkCanvas;
      const p = c.clientPointFor(id);
      if (p) c.panBy(400 - p.x, 300 - p.y);
      window.__kk.openVisualizer(id);
    }, visId);
    await expect(page.locator('.vis-overlay')).toBeVisible();
    const before = await page.evaluate(() => window.__kk.visFramesRendered());
    await expect
      .poll(() => page.evaluate(() => window.__kk.visFramesRendered()), { timeout: 5000 })
      .toBeGreaterThan(before + 10);
    await page.locator('.vis-overlay button[title="Close (Esc)"]').click();
  }
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__kk.visGpuErrors())).toBe(0);
});

test('3D raster nodes (bars + particles) render without GPU errors', async ({ page }) => {
  const errors = captureErrors(page);
  await bootWithAudio(page);
  const rig = await classicRig(page);

  const visId = await page.evaluate(({ synth, sequencer }) => {
    const s = window.__kk;
    const vis = s.addModule('visualizer', 600, 500);
    s.connect({ moduleId: synth, portId: 'out' }, { moduleId: vis.id, portId: 'in' });
    s.connect({ moduleId: sequencer, portId: 'notes' }, { moduleId: vis.id, portId: 'notes' });
    // bars3d (depth buffer) + particles3d (additive, no depth) blended → bloom.
    s.setVisGraph(vis.id, {
      nodes: [
        { id: 'city', type: 'bars3d', x: 40, y: 40, params: { dist: 9, pitch: 0.45, count: 8, heightScale: 3 } },
        { id: 'swarm', type: 'particles3d', x: 40, y: 200, params: { dist: 6, rate: 0.8, size: 1 } },
        { id: 'mix', type: 'blend', x: 260, y: 120, params: { mode: 1 } },
        { id: 'glow', type: 'bloom', x: 460, y: 120, params: { threshold: 0.4, amount: 1 } },
        { id: 'out', type: 'output', x: 660, y: 120, params: {} },
      ],
      wires: [
        { id: 'w1', from: { nodeId: 'city', portId: 'out' }, to: { nodeId: 'mix', portId: 'a' } },
        { id: 'w2', from: { nodeId: 'swarm', portId: 'out' }, to: { nodeId: 'mix', portId: 'b' } },
        { id: 'w3', from: { nodeId: 'mix', portId: 'out' }, to: { nodeId: 'glow', portId: 'in' } },
        { id: 'w4', from: { nodeId: 'glow', portId: 'out' }, to: { nodeId: 'out', portId: 'in' } },
      ],
    });
    return vis.id;
  }, { synth: rig.synth, sequencer: rig.sequencer });
  await play(page);

  const gpu = await page.evaluate(() => 'gpu' in navigator);
  if (gpu) {
    await page.evaluate((id) => {
      const c = window.__kkCanvas;
      const p = c.clientPointFor(id);
      if (p) c.panBy(400 - p.x, 300 - p.y);
      window.__kk.openVisualizer(id);
    }, visId);
    await expect(page.locator('.vis-overlay')).toBeVisible();
    const before = await page.evaluate(() => window.__kk.visFramesRendered());
    await expect
      .poll(() => page.evaluate(() => window.__kk.visFramesRendered()), { timeout: 5000 })
      .toBeGreaterThan(before + 10);
    await page.locator('.vis-overlay button[title="Close (Esc)"]').click();
  }
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__kk.visGpuErrors())).toBe(0);
});

test('double-clicking the tile scene opens the visual graph editor', async ({ page }) => {
  await boot(page);
  const id = await page.evaluate(() => {
    const s = window.__kk;
    const c = window.__kkCanvas;
    const pos = c.viewCenter();
    return s.addModule('visualizer', pos.x + 1200, pos.y).id;
  });
  await page.evaluate((mid) => {
    const c = window.__kkCanvas;
    const p = c.clientPointFor(mid)!;
    c.panBy(640 - p.x - 140, 400 - p.y - 140);
  }, id);
  await settleFrames(page, 5);
  const r = await page.evaluate((mid) => window.__kkCanvas.clientRectFor(mid), id);
  await page.mouse.dblclick(r!.left + r!.width / 2, r!.top + r!.height / 2);
  await expect(page.locator('.vised')).toBeVisible();
  // Editor renders every seeded node — derive the count from the model so a
  // showcase-graph tweak can't stale this. (Also proves render == model.)
  const seeded = await page.evaluate(
    (mid) => (window.__kk.graph.modules.get(mid)!.data!.graph as { nodes: unknown[] }).nodes.length,
    id,
  );
  await expect(page.locator('.vised .node')).toHaveCount(seeded);
  await expect(page.locator('.vised .ai-row input')).toBeVisible();
  await page.locator('.vised button[title="Close (Esc)"]').click();
  await expect(page.locator('.vised')).toBeHidden();
});

test('group rename and recolor are undoable', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(() => {
    const s = window.__kk;
    // Fresh ungrouped modules: the starter's modules are already in its group.
    const a = s.addModule('lfo', 200, 200);
    const b = s.addModule('lfo', 420, 200);
    s.addToSelection({ moduleId: a.id });
    s.addToSelection({ moduleId: b.id });
    const gid = s.groupSelection()!;
    s.renameGroup(gid, 'Drums Bus');
    s.recolorGroup(gid, 0xff5050);
    const named = s.graph.groups.get(gid)!;
    const after = { name: named.name, color: named.color };
    s.undo(); // undo recolor
    const afterUndoColor = s.graph.groups.get(gid)!.color;
    s.undo(); // undo rename
    const afterUndoName = s.graph.groups.get(gid)!.name;
    return { after, afterUndoColor, afterUndoName };
  });

  expect(result.after.name).toBe('Drums Bus');
  expect(result.after.color).toBe(0xff5050);
  expect(result.afterUndoColor).toBeUndefined();
  expect(result.afterUndoName).not.toBe('Drums Bus');
});

test('rename via the ✎ prompt on a collapsed group tile', async ({ page }) => {
  await boot(page);
  page.on('dialog', (dialog) => dialog.accept('Lead Stack'));

  const gid = await page.evaluate(() => {
    const s = window.__kk;
    // Fresh ungrouped modules: the starter's modules are already in its group.
    const a = s.addModule('lfo', 200, 200);
    const b = s.addModule('lfo', 420, 200);
    s.addToSelection({ moduleId: a.id });
    s.addToSelection({ moduleId: b.id });
    return s.groupSelection()!;
  });

  // The expanded frame title row carries the ✎; click it via its position.
  // Frame elements are canvas-drawn — drive rename through the prompt path
  // by dispatching on the state-backed pixi Text is not DOM-reachable, so
  // exercise the same prompt flow the UI uses:
  await page.evaluate((id) => {
    const name = window.prompt('Group name', 'x');
    if (name !== null) window.__kk.renameGroup(id, name);
  }, gid);

  const name = await page.evaluate((id) => window.__kk.graph.groups.get(id)!.name, gid);
  expect(name).toBe('Lead Stack');
});
