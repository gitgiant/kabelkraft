import { expect, test } from '@playwright/test';
import { boot, captureErrors, clearPatch, settleFrames } from './util';

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
  await page.mouse.click(pt!.x, pt!.y + 76);
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

test('tutorial button asks about saving first; cancel aborts', async ({ page }) => {
  await page.goto('/');
  await page.locator('.toolbar button[title="Start the tutorial"]').click();
  await expect(page.locator('.tutorial-dialog')).toBeVisible();

  // Cancel: no tutorial.
  await page.locator('button.cancel-tutorial').click();
  await expect(page.locator('.tutorial-dialog')).toBeHidden();
  await expect(page.locator('.tutorial')).toBeHidden();

  // Start without saving launches it.
  await page.locator('.toolbar button[title="Start the tutorial"]').click();
  await page.locator('button.just-start').click();
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
  expect(clip.trim().endsWith('Request: a warm dub bassline')).toBe(true);
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
