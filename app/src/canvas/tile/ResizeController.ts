/**
 * Shared all-sides resize for tiles (CONTAINER_UNIFICATION_PLAN.md phase 4).
 * ModuleView and GroupView duplicated the whole drag mechanism — eight
 * persistent hit-zones, `beginUndoable`, world-scale capture, raf-coalesced
 * move, opposite-edge anchoring, finalize. Only *what gets written* differed
 * (a module writes `instance.w/h` and clamps in its getters; a group writes
 * `group.w/h` or scales its face elements). This owns the mechanism; the view
 * supplies a policy for the writes.
 */

import { Container, FederatedPointerEvent, Graphics } from 'pixi.js';
import { appState } from '../../state';
import type { Tooltip } from '../Tooltip';
import { RESIZE_DIRS, inResizeBand, resizeCursor, resizeSize, type ResizeDir } from '../resize';

export interface ResizeStart {
  w: number;
  h: number;
  x: number;
  y: number;
}

export interface ResizePolicy {
  /** Current tile size — feeds the handles' live hit-tests. */
  getSize(): { w: number; h: number };
  /** Drag-start geometry, captured once on pointer-down. */
  getStart(): ResizeStart;
  /** Snapshot per-drag state (e.g. a group's face elements) before the first move. */
  beginDrag?(dir: ResizeDir, start: ResizeStart): void;
  /** Write the new size (raw, pre-clamp) and return the clamped size used for anchoring. */
  onDrag(dir: ResizeDir, rawW: number, rawH: number, start: ResizeStart): { w: number; h: number };
  /** Anchor the opposite edge for n/w drags (write model x/y). */
  onAnchor(dir: ResizeDir, w: number, h: number, start: ResizeStart): void;
  /** Persist the final clamped size (modules store the clamped value; groups already did). */
  commit?(w: number, h: number): void;
  /** Rebuild the tile view and reposition it. */
  rerender(): void;
  /** Double-click a handle → revert to default size (modules only). */
  onResetDefault?(): void;
  /** Yield the hit-test to a pole sitting under the handle (groups only). */
  overPole?(px: number, py: number): boolean;
}

export class ResizeController {
  private handles: Graphics[] = [];

  constructor(
    private host: Container,
    private tooltip: Tooltip,
    private policy: ResizePolicy,
  ) {}

  /** Create the eight hit-zones once, then (re-)attach them on top of the body
   * (their hit-tests read the live size, so they survive rebuilds untouched). */
  mount(): void {
    if (this.handles.length === 0) {
      const tip = this.policy.onResetDefault
        ? ['Resize', 'Drag any edge or corner. Double-click: default size.']
        : ['Resize', 'Drag any edge or corner.'];
      for (const dir of RESIZE_DIRS) {
        const g = new Graphics();
        g.eventMode = 'static';
        g.cursor = resizeCursor(dir);
        g.hitArea = {
          contains: (px, py) => {
            const { w, h } = this.policy.getSize();
            if (!inResizeBand(dir, px, py, w, h)) return false;
            return this.policy.overPole ? !this.policy.overPole(px, py) : true;
          },
        };
        g.on('pointerdown', (e) => {
          e.stopPropagation();
          if (this.policy.onResetDefault && e.detail >= 2) {
            appState.beginUndoable();
            this.policy.onResetDefault();
            return;
          }
          this.begin(dir, e);
        });
        g.on('pointerover', (ev) => this.tooltip.show(tip, ev.clientX, ev.clientY));
        g.on('pointerout', () => this.tooltip.hide());
        this.handles.push(g);
      }
    }
    for (const g of this.handles) this.host.addChild(g);
  }

  /** Is `g` one of the persistent handles? (rebuilds keep these alive.) */
  has(g: Graphics): boolean {
    return this.handles.includes(g);
  }

  private begin(dir: ResizeDir, e: FederatedPointerEvent): void {
    appState.beginUndoable(); // whole resize = one undo step
    const start = this.policy.getStart();
    const sx = e.clientX;
    const sy = e.clientY;
    const scale = this.host.worldTransform.a || 1;
    this.policy.beginDrag?.(dir, start);
    let raf = 0;
    let last = { w: start.w, h: start.h };
    const apply = (ev: PointerEvent): void => {
      const raw = resizeSize(dir, (ev.clientX - sx) / scale, (ev.clientY - sy) / scale, start.w, start.h);
      last = this.policy.onDrag(dir, raw.w, raw.h, start);
      this.policy.onAnchor(dir, last.w, last.h, start);
    };
    const onMove = (ev: PointerEvent): void => {
      apply(ev);
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          this.policy.rerender();
        });
      }
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (raf) cancelAnimationFrame(raf);
      this.policy.commit?.(last.w, last.h);
      this.policy.onAnchor(dir, last.w, last.h, start);
      this.policy.rerender();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
}
