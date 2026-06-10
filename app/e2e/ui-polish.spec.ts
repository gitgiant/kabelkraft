import { expect, test } from '@playwright/test';

test('palette search filters modules', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.palette .module-entry')).toHaveCount(42);

  await page.locator('.palette-search').fill('filt');
  await expect(page.locator('.palette .module-entry', { hasText: 'Filter' })).toBeVisible();
  // Far fewer than the full list (name/description matches only).
  const count = await page.locator('.palette .module-entry').count();
  expect(count).toBeLessThan(10);
  await expect(page.locator('.palette .module-entry', { hasText: 'Sequencer' })).toBeHidden();

  await page.locator('.palette-search').fill('zzzznothing');
  await expect(page.locator('.no-match')).toBeVisible();

  await page.locator('.palette-search').fill('');
  await expect(page.locator('.palette .module-entry')).toHaveCount(42);
});

test('selecting a wire and pressing Delete removes it', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(400);

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
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await page.waitForTimeout(400);

  // Empty canvas so the collision resolver / group tile can't shift the vcf.
  const vcf = await page.evaluate(() => {
    const s = window.__kk;
    for (const g of [...s.graph.groups.keys()]) s.ungroup(g);
    for (const m of [...s.graph.modules.values()]) s.removeModule(m.id);
    return s.addModule('vcf', 250, -380).id;
  });
  await page.waitForTimeout(300); // fresh tile needs a rendered frame

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

  // Cutoff knob drag (left knob) raises cutoff.
  await page.mouse.move(pt!.x - 43, pt!.y - 49);
  await page.mouse.down();
  await page.mouse.move(pt!.x - 43, pt!.y - 109, { steps: 5 });
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

test('AI dialog copies spec + USER PROMPT', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.locator('button.ai-toggle').click();
  await expect(page.locator('.ai-dialog')).toBeVisible();

  await page.locator('.ai-prompt').fill('a warm dub bassline');
  await page.locator('button.copy-spec').click();
  await expect(page.locator('button.copy-spec')).toHaveText(/Copied/);

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('KabelKraft'); // the spec pack
  expect(clip.trim().endsWith('USER PROMPT: a warm dub bassline')).toBe(true);
});
