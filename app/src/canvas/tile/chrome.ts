/**
 * Shared tile chrome — the bits every container/module tile draws the same way
 * (CONTAINER_UNIFICATION_PLAN.md). Stateless helpers, owned by no view: both
 * ModuleView and GroupView call these so the title-bar buttons, double-tap
 * toggle gesture, and headless-embed body live in one place.
 */

import { Container, Graphics, Text } from 'pixi.js';
import { theme } from '../../theme';
import type { Tooltip } from '../Tooltip';

/**
 * A right-aligned glyph button on a tile's title bar. Glyph bounds are
 * font-dependent, so the clickable area is a fixed hit rect anchored at `x`.
 */
export function addTitleButton(
  host: Container,
  tooltip: Tooltip,
  glyph: string,
  x: number,
  tip: string[],
  onTap: () => void,
): void {
  const t = new Text({ text: glyph, style: { fontSize: 11, fill: theme.textDim } });
  t.anchor.set(1, 0);
  t.position.set(x, 6);
  t.eventMode = 'none';
  host.addChild(t);
  const hit = new Graphics().rect(x - 14, 2, 18, 20).fill({ color: 0xffffff, alpha: 0.001 });
  hit.eventMode = 'static';
  hit.cursor = 'pointer';
  hit.on('pointerdown', (e) => {
    e.stopPropagation();
    onTap();
  });
  hit.on('pointerover', (e) => tooltip.show(tip, e.clientX, e.clientY));
  hit.on('pointerout', () => tooltip.hide());
  host.addChild(hit);
}

export interface ToggleTapOpts {
  /** Ignore taps whose tile-local Y falls below the title bar (faced tiles). */
  titleBarOnly?: boolean;
  /** Title-bar height for the `titleBarOnly` test. */
  titleH?: number;
  /** Reset the timer on fire so a third rapid tap can't re-fire (ModuleView). */
  resetOnFire?: boolean;
}

/**
 * Double-tap-to-toggle on a tile node. A manual 350ms timer, not native
 * `e.detail` — detail keeps counting past 2 across rapid successive clicks.
 */
export function attachToggleTap(node: Container, onToggle: () => void, opts: ToggleTapOpts = {}): void {
  let lastTap = 0;
  node.on('pointertap', (e) => {
    if (opts.titleBarOnly && node.toLocal(e.global).y > (opts.titleH ?? 24)) return;
    const now = performance.now();
    if (now - lastTap < 350) {
      if (opts.resetOnFire) lastTap = 0;
      onToggle();
      if (opts.resetOnFire) return;
    }
    lastTap = now;
  });
}

export interface HeadlessBodyOpts {
  /** Double-tap drills into the embedded target's editor; absent = inert embed. */
  onOpen?: () => void;
  /** Hover tooltip lines (caller bakes the open/closed copy). */
  tooltipLines: string[];
}

/**
 * A headless embed's body: swallows drags (the host tile must not move from
 * inside the embed) and double-taps into the target. Caller has already added
 * `body` to the tile.
 */
export function attachHeadlessBody(body: Graphics, tooltip: Tooltip, opts: HeadlessBodyOpts): void {
  body.eventMode = 'static';
  body.cursor = opts.onOpen ? 'pointer' : 'default';
  let lastTap = 0;
  body.on('pointertap', () => {
    const now = performance.now();
    if (now - lastTap < 350) {
      lastTap = 0;
      opts.onOpen?.();
    } else {
      lastTap = now;
    }
  });
  body.on('pointerover', (e) => tooltip.show(opts.tooltipLines, e.clientX, e.clientY));
  body.on('pointerout', () => tooltip.hide());
}
