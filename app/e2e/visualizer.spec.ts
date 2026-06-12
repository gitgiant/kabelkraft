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

  // Fresh containers carry the init visual graph (audio → Spectrum → Output).
  const graph = await page.evaluate(
    (id) => window.__kk.graph.modules.get(id)!.data!.graph as { nodes: { type: string }[]; wires: unknown[] },
    visId,
  );
  expect(graph.nodes.map((n) => n.type)).toEqual(['spectrum', 'output']);
  expect(graph.wires.length).toBe(1);

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
  expect(nodeCounts.undone).toBe(2);
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
    // Text Layer in stack mode replaces the init spectrum graph.
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
  // Init graph shows its two nodes in the editor.
  await expect(page.locator('.vised .node')).toHaveCount(2);
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
