/**
 * All-sides resize geometry shared by ModuleView (module tiles) and GroupView
 * (faced + plain group tiles). Eight grab zones — four edges + four corners —
 * expressed as live hit-test predicates so a single set of persistent handles
 * works at any current tile size (handles are never destroyed mid-gesture,
 * which is what keeps PixiJS's cursor/hover tracking from wedging).
 */

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const RESIZE_DIRS: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** Native CSS cursor for a resize direction. */
export function resizeCursor(dir: ResizeDir): string {
  if (dir === 'n' || dir === 's') return 'ns-resize';
  if (dir === 'e' || dir === 'w') return 'ew-resize';
  if (dir === 'ne' || dir === 'sw') return 'nesw-resize';
  return 'nwse-resize'; // nw, se
}

const EDGE = 8; // edge band half-thickness (local px)
const CORNER = 16; // corner box reach (local px)

/** True when local (px,py) falls in this direction's grab band of a w×h tile. */
export function inResizeBand(
  dir: ResizeDir,
  px: number,
  py: number,
  w: number,
  h: number,
): boolean {
  const nearN = py >= -EDGE && py <= EDGE;
  const nearS = py >= h - EDGE && py <= h + EDGE;
  const nearW = px >= -EDGE && px <= EDGE;
  const nearE = px >= w - EDGE && px <= w + EDGE;
  const inX = px >= -EDGE && px <= w + EDGE;
  const inY = py >= -EDGE && py <= h + EDGE;
  switch (dir) {
    case 'nw': return px <= CORNER && py <= CORNER && px >= -EDGE && py >= -EDGE;
    case 'ne': return px >= w - CORNER && py <= CORNER && px <= w + EDGE && py >= -EDGE;
    case 'sw': return px <= CORNER && py >= h - CORNER && px >= -EDGE && py <= h + EDGE;
    case 'se': return px >= w - CORNER && py >= h - CORNER && px <= w + EDGE && py <= h + EDGE;
    // Edges exclude the corner reach so the two never overlap.
    case 'n': return nearN && inX && px > CORNER && px < w - CORNER;
    case 's': return nearS && inX && px > CORNER && px < w - CORNER;
    case 'w': return nearW && inY && py > CORNER && py < h - CORNER;
    case 'e': return nearE && inY && py > CORNER && py < h - CORNER;
  }
}

/** New width/height for a drag delta (local px). Caller clamps + anchors. */
export function resizeSize(
  dir: ResizeDir,
  dx: number,
  dy: number,
  startW: number,
  startH: number,
): { w: number; h: number } {
  let w = startW;
  let h = startH;
  if (dir.includes('e')) w = startW + dx;
  if (dir.includes('w')) w = startW - dx;
  if (dir.includes('s')) h = startH + dy;
  if (dir.includes('n')) h = startH - dy;
  return { w, h };
}
