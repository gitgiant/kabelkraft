import { expect, type Page } from '@playwright/test';

/* ------------------------------------------------------------------ *
 * Boot / error capture
 * ------------------------------------------------------------------ */

/**
 * Attach console/page error capture. Call BEFORE page.goto so nothing is
 * missed; assert `expect(errors).toEqual([])` at the end of the test.
 */
export function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err)}`));
  return errors;
}

/** Load the app and wait until state + canvas are actually live (no blind sleeps). */
export async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.canvas-container canvas:not(.bg-vis)')).toBeVisible();
  // Starter patch seeds modules; "ready" = state mounted and canvas views built.
  await expect
    .poll(() =>
      page.evaluate(() => !!window.__kk && window.__kk.graph.modules.size > 0),
    )
    .toBe(true);
  await settleFrames(page);
}

/** boot + click Enable Audio and wait for the engine to come up. */
export async function bootWithAudio(page: Page): Promise<void> {
  await boot(page);
  await page.locator('.enable-audio').click();
  await expect(page.locator('.audio-on')).toBeVisible({ timeout: 3000 });
}

/**
 * Wait for n rendered frames — use after graph changes that rebuild canvas
 * tiles, before mouse hit-testing. Replaces fixed 200–500 ms sleeps.
 */
export async function settleFrames(page: Page, n = 3): Promise<void> {
  await page.evaluate(
    (frames) =>
      new Promise<void>((resolve) => {
        const tick = (left: number) =>
          left <= 0 ? resolve() : requestAnimationFrame(() => tick(left - 1));
        tick(frames);
      }),
    n,
  );
}

/* ------------------------------------------------------------------ *
 * Graph helpers
 * ------------------------------------------------------------------ */

/** Remove every group and module — a guaranteed-clean canvas. */
export async function clearPatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = window.__kk;
    for (const g of [...s.graph.groups.keys()]) s.ungroup(g);
    for (const m of [...s.graph.modules.values()]) s.removeModule(m.id);
  });
}

export interface ClassicRig {
  sequencer: string;
  keyboard: string;
  /** Audio source / final voice stage — the VCA. Back-compat alias used by most specs. */
  synth: string;
  voice: string;
  osc: string;
  vcf: string;
  vca: string;
  adsr: string;
  lfo: string;
  out: string;
  levels: string;
}

/**
 * The classic test rig, rebuilt from components (the monolithic synth is gone):
 * sequencer + keyboard → voice → osc → vcf → vca → audioOut + levels, with an
 * amp ADSR on the VCA and an LFO on the filter. `synth` aliases the VCA (the
 * final audio stage feeding the output), so specs that splice effects after the
 * "synth" or read its meter/level still work; specs that need a filter cutoff
 * use `vcf`.
 */
export async function classicRig(page: Page): Promise<ClassicRig> {
  const rig = await page.evaluate(() => {
    const s = window.__kk;
    for (const g of [...s.graph.groups.keys()]) s.ungroup(g);
    for (const m of [...s.graph.modules.values()]) s.removeModule(m.id);
    s.addModule('transport', -150, -300);
    const sequencer = s.addModule('sequencer', -980, -220);
    const keyboard = s.addModule('keyboard', -980, 120);
    const voice = s.addModule('voice', -680, -120);
    const osc = s.addModule('osc', -360, -260);
    const adsr = s.addModule('envelope', -680, 220);
    // lfo sits just under the vcf: faces.spec groups vcf+lfo and expands it, so
    // the pair must stay compact and on-screen for param hit-testing.
    const lfo = s.addModule('lfo', -40, 200);
    const vcf = s.addModule('vcf', -40, -200);
    const vca = s.addModule('vca', 320, -60);
    const out = s.addModule('audioOut', 640, 40);
    const levels = s.addModule('levels', 640, 320);
    const wire = (f: string, fp: string, t: string, tp: string) =>
      s.connect({ moduleId: f, portId: fp }, { moduleId: t, portId: tp });
    wire(sequencer.id, 'notes', voice.id, 'notes');
    wire(keyboard.id, 'notes', voice.id, 'notes');
    wire(voice.id, 'pitch', osc.id, 'pitch');
    wire(voice.id, 'gate', adsr.id, 'gate');
    wire(osc.id, 'out', vcf.id, 'in');
    wire(lfo.id, 'out', vcf.id, 'mod');
    wire(vcf.id, 'out', vca.id, 'in');
    wire(adsr.id, 'out', vca.id, 'cv');
    wire(vca.id, 'out', out.id, 'in');
    wire(vca.id, 'out', levels.id, 'in');
    return {
      sequencer: sequencer.id,
      keyboard: keyboard.id,
      synth: vca.id,
      voice: voice.id,
      osc: osc.id,
      vcf: vcf.id,
      vca: vca.id,
      adsr: adsr.id,
      lfo: lfo.id,
      out: out.id,
      levels: levels.id,
    };
  });
  await settleFrames(page);
  return rig;
}

/** Find a module id by type (throws if absent — fail fast with a clear message). */
export async function moduleByType(page: Page, type: string): Promise<string> {
  const id = await page.evaluate(
    (t) => [...window.__kk.graph.modules.values()].find((m) => m.type === t)?.id ?? null,
    type,
  );
  if (!id) throw new Error(`no module of type "${type}" in the graph`);
  return id;
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

export async function play(page: Page): Promise<void> {
  await page.locator('.transport button[title^="Play"]').click();
}

export async function stop(page: Page): Promise<void> {
  await page.locator('.transport button[title^="Stop"]').click();
}

/* ------------------------------------------------------------------ *
 * Meters / control values — poll the condition, never sleep-then-read
 * ------------------------------------------------------------------ */

export function peakOf(page: Page, id: string): Promise<number> {
  return page.evaluate((i) => window.__kk.meters[i]?.peak ?? 0, id);
}

/** Wait until a module's peak meter rises above min (audio is flowing). */
export function pollPeak(page: Page, id: string, min = 0.01, timeout = 5000) {
  return expect.poll(() => peakOf(page, id), { timeout }).toBeGreaterThan(min);
}

/** Wait until a module's peak meter falls below max (audio has stopped). */
export function pollPeakBelow(page: Page, id: string, max = 0.01, timeout = 5000) {
  return expect.poll(() => peakOf(page, id), { timeout }).toBeLessThan(max);
}

/** expect.poll on a module's control output value. */
export function pollControl(page: Page, id: string, timeout = 5000) {
  return expect.poll(
    () => page.evaluate((i) => window.__kk.controlValues[i], id),
    { timeout },
  );
}

/**
 * Wait until the meter has clearly responded to a change: polls until peak
 * passes `predicate`. Use instead of waitForTimeout-then-read comparisons.
 */
export function pollPeakUntil(
  page: Page,
  id: string,
  predicate: (peak: number) => boolean,
  timeout = 5000,
) {
  return expect
    .poll(async () => predicate(await peakOf(page, id)), { timeout })
    .toBe(true);
}

/* ------------------------------------------------------------------ *
 * Canvas geometry — single home for face/tile layout math, so a layout
 * change breaks one helper here instead of pixel offsets in N specs.
 * ------------------------------------------------------------------ */

/** Title bar height of module tiles and collapsed group tiles. */
export const TILE_TITLE_H = 24;

/**
 * Client-space center of a face element on a COLLAPSED group tile.
 * `tilePt` is clientPointForGroup (tile top-left + world scale); offsets are in
 * tile-local px and are scaled by `tilePt.scale` (the view auto-zooms to fit).
 * The element's rotary / active area is the top w×w square of its box.
 */
export function faceElementCenter(
  tilePt: { x: number; y: number; scale: number },
  el: { x: number; y: number; w: number },
): { x: number; y: number } {
  return {
    x: tilePt.x + (el.x + el.w / 2) * tilePt.scale,
    y: tilePt.y + (TILE_TITLE_H + el.y + el.w / 2) * tilePt.scale,
  };
}

/** The ⛶ expand button near the right edge of a collapsed group's title bar. */
export function groupExpandButton(
  tilePt: { x: number; y: number; scale: number },
  faceWidth: number,
): { x: number; y: number } {
  return {
    x: tilePt.x + (faceWidth - 70) * tilePt.scale,
    y: tilePt.y + (TILE_TITLE_H / 2) * tilePt.scale,
  };
}

/** Map a tile-local point (px, relative to the group tile's top-left, before
 * the title bar) to client space, applying the view's auto-fit scale. */
export function groupLocalPoint(
  tilePt: { x: number; y: number; scale: number },
  lx: number,
  ly: number,
): { x: number; y: number } {
  return { x: tilePt.x + lx * tilePt.scale, y: tilePt.y + ly * tilePt.scale };
}

/**
 * Client-space center of a face knob bound to `moduleId:paramId` on a collapsed
 * group tile — found by walking the live face tree (the knob may sit inside a
 * nested group sub-panel embed). Geometry is derived from the actual face
 * elements + embed transforms, so a starter-patch face redesign can't stale it.
 * Returns null if no such knob is on the tile.
 */
export async function faceKnobClient(
  page: Page,
  groupId: string,
  moduleId: string,
  paramId: string,
): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    ([gid, mid, pid, titleH]) => {
      const s = window.__kk;
      type Pt = { x: number; y: number } | null;
      // Knob/sub-panel embed math mirrors GroupView.buildFaceElement /
      // buildGroupViewElement: returns the knob center in group-tile-local px.
      const center = (g: { face?: { width: number; height: number; elements: Array<Record<string, unknown>> } }, depth = 0): Pt => {
        const face = g.face;
        if (!face || depth > 6) return null;
        for (const el of face.elements) {
          if (el.kind === 'knob' && el.moduleId === mid && el.paramId === pid) {
            const w = el.w as number, h = el.h as number;
            const r = Math.max(8, Math.min(w, h - (el.label ? 16 : 0)) / 2 - 6);
            return { x: (el.x as number) + w / 2, y: titleH + (el.y as number) + r + 6 };
          }
        }
        for (const el of face.elements) {
          if (el.kind === 'view' && el.groupId) {
            const child = s.graph.groups.get(el.groupId as string);
            const inner = child ? center(child, depth + 1) : null;
            if (inner && child?.face) {
              const ew = el.w as number, eh = el.h as number;
              const sc = Math.min(ew / child.face.width, eh / child.face.height);
              return {
                x: (el.x as number) + (ew - child.face.width * sc) / 2 + inner.x * sc,
                y: titleH + (el.y as number) + (eh - child.face.height * sc) / 2 - titleH * sc + inner.y * sc,
              };
            }
          }
        }
        return null;
      };
      const grp = s.graph.groups.get(gid);
      const c = grp ? center(grp) : null;
      const pt = window.__kkCanvas.clientPointForGroup(gid);
      if (!c || !pt) return null;
      return { x: pt.x + c.x * pt.scale, y: pt.y + c.y * pt.scale };
    },
    [groupId, moduleId, paramId, TILE_TITLE_H] as const,
  );
}

/**
 * Click a canvas point until the expected effect is observed. Canvas tiles
 * rebuild asynchronously after graph changes, so a single click can land
 * before the hit area is live — retrying on the observed effect is robust
 * against render timing without hard-coded sleeps.
 */
export async function clickUntil(
  page: Page,
  point: () => Promise<{ x: number; y: number } | null>,
  took: () => Promise<boolean>,
  opts: { attempts?: number; dblclick?: boolean } = {},
): Promise<void> {
  const { attempts = 8, dblclick = false } = opts;
  for (let i = 0; i < attempts; i++) {
    await settleFrames(page);
    const pt = await point();
    if (pt) {
      if (dblclick) await page.mouse.dblclick(pt.x, pt.y, { delay: 80 });
      else await page.mouse.click(pt.x, pt.y);
      if (await took()) return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('clickUntil: effect never observed');
}

/** Drag vertically from a point (knob-style drag). */
export async function dragVertical(
  page: Page,
  pt: { x: number; y: number },
  dy: number,
): Promise<void> {
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.move(pt.x, pt.y + dy, { steps: 5 });
  await page.mouse.up();
}
