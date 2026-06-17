import { expect, test } from '@playwright/test';
import { boot, captureErrors, classicRig, clearPatch, settleFrames } from './util';

test('palette search filters modules', async ({ page }) => {
  await boot(page);
  // Full list size comes from the app's own registry — adding modules later
  // must not break this test.
  const total = await page.evaluate(
    () => window.__kkMeta.moduleDefCount + window.__kkMeta.starterCount,
  );
  await expect(page.locator('.palette .module-entry')).toHaveCount(total);

  await page.locator('.palette-search').fill('filt');
  await expect(page.locator('.palette .module-entry', { hasText: 'Filter' })).toBeVisible();
  // Far fewer than the full list (name/description matches only).
  const count = await page.locator('.palette .module-entry').count();
  expect(count).toBeLessThan(total / 3);
  await expect(page.locator('.palette .module-entry', { hasText: 'Sequencer' })).toBeHidden();

  await page.locator('.palette-search').fill('zzzznothing');
  await expect(page.locator('.no-match')).toBeVisible();

  await page.locator('.palette-search').fill('');
  await expect(page.locator('.palette .module-entry')).toHaveCount(total);
});

test('selecting a wire and pressing Delete removes it', async ({ page }) => {
  await boot(page);

  const { wireId, wireCount } = await page.evaluate(() => {
    const s = window.__kk;
    const wire = [...s.graph.wires.values()][0];
    s.select({ wireId: wire.id });
    return { wireId: wire.id, wireCount: s.graph.wires.size };
  });

  await page.keyboard.press('Delete');
  const after = await page.evaluate(() => ({
    count: window.__kk.graph.wires.size,
    ids: [...window.__kk.graph.wires.keys()],
  }));
  expect(after.count).toBe(wireCount - 1);
  expect(after.ids).not.toContain(wireId);
});

test('filter face: response curve drag sets cutoff + Q; knobs work', async ({ page }) => {
  const errors = captureErrors(page);
  await boot(page);

  // Empty canvas so the collision resolver / group tile can't shift the vcf.
  await clearPatch(page);
  const vcf = await page.evaluate(() => window.__kk.addModule('vcf', 250, -380).id);
  await settleFrames(page); // fresh tile needs a rendered frame

  // Drag on the curve display (bottom area): center = cutoff ≈ √(40·18000), Q ≈ mid.
  const pt = await page.evaluate((i) => window.__kkCanvas.clientPointFor(i), vcf);
  await page.mouse.click(pt!.x, pt!.y + 76 * pt!.scale);
  const mid = await page.evaluate(
    (i) => window.__kk.graph.modules.get(i)!.params, vcf,
  );
  expect(mid.cutoff).toBeGreaterThan(500);
  expect(mid.cutoff).toBeLessThan(1500);
  expect(mid.res).toBeGreaterThan(0.3);
  expect(mid.res).toBeLessThan(0.65);

  // Cutoff knob drag raises cutoff.
  const knobPt = await page.evaluate(
    (i) => window.__kkCanvas.clientPointForParam(i, 'cutoff'), vcf,
  );
  await page.mouse.move(knobPt!.x, knobPt!.y);
  await page.mouse.down();
  await page.mouse.move(knobPt!.x, knobPt!.y - 60, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(
    (i) => window.__kk.graph.modules.get(i)!.params.cutoff, vcf,
  );
  expect(after).toBeGreaterThan(mid.cutoff as number);

  expect(errors).toEqual([]);
});

test('tutorial restart asks about saving first; cancel aborts', async ({ page }) => {
  await page.goto('/');
  // The tutorial moved into Options → General.
  await page.locator('.options-toggle').click();
  await page.locator('.options-tabs .tab[data-tab="general"]').click();
  await page.locator('.restart-tutorial').click();
  await expect(page.locator('.tutorial-dialog')).toBeVisible();

  // Cancel: no tutorial, Options stays open.
  await page.locator('button.cancel-tutorial').click();
  await expect(page.locator('.tutorial-dialog')).toBeHidden();
  await expect(page.locator('.tutorial')).toBeHidden();

  // Start without saving closes Options and launches it.
  await page.locator('.restart-tutorial').click();
  await page.locator('button.just-start').click();
  await expect(page.locator('.options-dialog')).toHaveCount(0);
  await expect(page.locator('.tutorial')).toBeVisible();
});

test('AI dialog copies spec + context + request', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.locator('button.ai-toggle').click();
  await expect(page.locator('.ai-dialog')).toBeVisible();

  await page.locator('.ai-prompt').fill('a warm dub bassline');
  await page.locator('button.copy-spec').click();
  await expect(page.locator('button.copy-spec')).toHaveText(/Copied/);

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('KabelKraft'); // the spec pack
  expect(clip).toContain('Current project:'); // live context rides along
  expect(clip.trim().startsWith('Request: a warm dub bassline')).toBe(true); // prompt-first
});

test('container tiles (composer, visualizer) stretch beyond the 3× cap', async ({ page }) => {
  await boot(page);
  const sizes = await page.evaluate(() => {
    const s = window.__kk;
    const c = window.__kkCanvas;
    const vis = s.addModule('visualizer', 600, 500);
    const comp = s.addModule('composer', 2000, 500);
    const knob = s.addModule('lfo', 3500, 500);
    // Huge instance sizes — view getters clamp live, no rebuild needed.
    for (const m of [vis, comp, knob]) {
      m.w = 4000;
      m.h = 3000;
    }
    const zoom = c.clientRectFor(vis.id)!.scale;
    const dims = (id: string) => {
      const r = c.clientRectFor(id)!;
      return { w: Math.round(r.width / zoom), h: Math.round(r.height / zoom) };
    };
    return { vis: dims(vis.id), comp: dims(comp.id), knob: dims(knob.id) };
  });
  // Containers take the full requested size (old cap: 3× default ≈ 840/960).
  expect(sizes.vis).toEqual({ w: 4000, h: 3000 });
  expect(sizes.comp).toEqual({ w: 4000, h: 3000 });
  // Non-container tiles keep the 3× sanity cap.
  expect(sizes.knob.w).toBeLessThan(4000);
  expect(sizes.knob.h).toBeLessThan(3000);
});

test('double-clicking a container title bar toggles open ↔ shrink', async ({ page }) => {
  await boot(page);
  // Empty canvas so the collision resolver can't shift tiles between the
  // two clicks of a double-click.
  await clearPatch(page);
  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const comp = s.addModule('composer', 600, 400);
    const vis = s.addModule('visualizer', 1400, 400);
    return { comp: comp.id, vis: vis.id };
  });

  const dblOnTitle = async (id: string, until: () => Promise<boolean>) => {
    // Canvas hit areas lag tile rebuilds — retry like clickUntil.
    for (let i = 0; i < 8; i++) {
      // Pan the tile's TOP edge to a fixed spot clear of the app toolbar —
      // grown container tiles are taller than the viewport center allows.
      await page.evaluate((mid) => {
        const c = window.__kkCanvas;
        const r = c.clientRectFor(mid);
        if (r) c.panBy(400 - r.left, 150 - r.top);
      }, id);
      await settleFrames(page, 4);
      const r = await page.evaluate((mid) => window.__kkCanvas.clientRectFor(mid), id);
      if (r) await page.mouse.dblclick(r.left + 60 * r.scale, r.top + 12 * r.scale);
      await settleFrames(page, 2);
      if (await until()) return;
    }
    expect(await until()).toBe(true);
  };

  // Composer: title dblclick opens the piano roll, again shrinks it.
  await dblOnTitle(ids.comp, () =>
    page.evaluate((id) => window.__kk.composerOpen.has(id), ids.comp),
  );
  await dblOnTitle(ids.comp, () =>
    page.evaluate((id) => !window.__kk.composerOpen.has(id), ids.comp),
  );

  // Visualizer: title dblclick opens the graph editor in-tile, again shrinks
  // back to the compact container (big view keeps its ⛶ button).
  await dblOnTitle(ids.vis, () =>
    page.evaluate((id) => window.__kk.visEditorOpen === id, ids.vis),
  );
  await expect(page.locator('.vised')).toBeVisible();
  await dblOnTitle(ids.vis, () =>
    page.evaluate(() => window.__kk.visEditorOpen === null),
  );
  await expect(page.locator('.vised')).toBeHidden();
});

test('intelligence module accepts every input type (placeholder face)', async ({ page }) => {
  const errors = captureErrors(page);
  await boot(page);
  const rig = await classicRig(page);
  const result = await page.evaluate((synthId) => {
    const s = window.__kk;
    const ai = s.addModule('intelligence', 800, 600);
    const seq = s.addModule('sequencer', 300, 700);
    const lfo = s.addModule('lfo', 300, 1000);
    const text = s.addModule('textinput', 300, 1300);
    const vis = s.addModule('visualizer', 300, 1600);
    return {
      ports: [
        s.connect({ moduleId: synthId, portId: 'out' }, { moduleId: ai.id, portId: 'in' }).ok,
        s.connect({ moduleId: seq.id, portId: 'notes' }, { moduleId: ai.id, portId: 'notes' }).ok,
        s.connect({ moduleId: lfo.id, portId: 'out' }, { moduleId: ai.id, portId: 'mod' }).ok,
        s.connect({ moduleId: text.id, portId: 'out' }, { moduleId: ai.id, portId: 'text' }).ok,
        s.connect({ moduleId: vis.id, portId: 'vout' }, { moduleId: ai.id, portId: 'vin' }).ok,
      ],
    };
  }, rig.synth);
  expect(result.ports).toEqual([true, true, true, true, true]);
  await settleFrames(page, 5);
  expect(errors).toEqual([]);
});

test('auto-wire button chains the selected modules left-to-right', async ({ page }) => {
  await boot(page);
  await clearPatch(page);

  const wireBtn = page.locator('.toolbar button.auto-wire');
  await expect(wireBtn).toBeDisabled(); // empty canvas — nothing to wire

  await page.evaluate(() => {
    const s = window.__kk;
    const kb = s.addModule('keyboard', 300, 400);
    const smpl = s.addModule('smpl', 700, 400);
    const out = s.addModule('audioOut', 1100, 400);
    s.select({ moduleId: kb.id });
    s.addToSelection({ moduleId: smpl.id });
    s.addToSelection({ moduleId: out.id });
  });
  await expect(wireBtn).toBeEnabled();

  await wireBtn.click();
  const wires = await page.evaluate(() =>
    [...window.__kk.graph.wires.values()].map((w) => w.type).sort(),
  );
  expect(wires).toEqual(['audio', 'note']);

  // Idempotent: every matching port is taken now, second click adds nothing.
  await wireBtn.click();
  expect(await page.evaluate(() => window.__kk.graph.wires.size)).toBe(2);

  // One undo step removes the whole auto-wire batch.
  await page.evaluate(() => window.__kk.undo());
  expect(await page.evaluate(() => window.__kk.graph.wires.size)).toBe(0);
});

test('auto-wire with no selection wires the whole patch, groups via poles', async ({ page }) => {
  await boot(page);
  await clearPatch(page);

  const wireBtn = page.locator('.toolbar button.auto-wire');

  // keyboard + a grouped voice (smpl→audioOut wired internally): nothing
  // selected — auto-wire still chains keyboard.notes into the group's pole.
  await page.evaluate(() => {
    const s = window.__kk;
    const kb = s.addModule('keyboard', 300, 400);
    const smpl = s.addModule('smpl', 700, 400);
    const out = s.addModule('audioOut', 1100, 400);
    s.connect({ moduleId: smpl.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
    s.select({ moduleId: smpl.id });
    s.addToSelection({ moduleId: out.id });
    s.groupSelection();
    s.clearSelection();
    void kb;
  });
  await expect(wireBtn).toBeEnabled(); // no selection needed anymore

  await wireBtn.click();
  const noteWire = await page.evaluate(() =>
    [...window.__kk.graph.wires.values()].some(
      (w) => w.type === 'note' && w.to.portId === 'notes',
    ),
  );
  expect(noteWire).toBe(true);
});
