/**
 * Shared port/pole rail for tiles (CONTAINER_UNIFICATION_PLAN.md phase 2).
 * ModuleView and GroupView placed their port dots with byte-identical layout
 * and an identical `drawDot`; only the port *model* (def ports vs boundary
 * ports), hover tooltip, and hit radius differed. This owns the dots,
 * `portCenters`/`portDots` maps, highlight redraws, and the wire-up — views map
 * their native ports to a normalized `Pole[]` and call `build`.
 */

import { Container, FederatedPointerEvent, Graphics } from 'pixi.js';
import { PORT_TYPE_COLORS, type PortType } from '../../core/types';
import type { Tooltip } from '../Tooltip';

export const PORT_RADIUS = 7;
const TITLE_H = 24;

/** A normalized pole the rail can place — views adapt their native ports to it. */
export interface Pole {
  /** Identity key for `portCenters`/highlight lookups (port id, or group `${moduleId}:${portId}`). */
  key: string;
  type: PortType;
  direction: 'in' | 'out';
  /** Hover tooltip lines, computed lazily (the inside-module label can change). */
  tooltip(): string[];
  onDown(e: FederatedPointerEvent): void;
  onUp(e: FederatedPointerEvent): void;
}

/** Shared typed-dot port rail: inputs on the left edge, outputs on the right. */
export class PoleRail {
  /** Tile-local pole centers, keyed by `Pole.key`. */
  readonly centers = new Map<string, { x: number; y: number }>();
  private dots = new Map<string, Graphics>();
  private types = new Map<string, PortType>();

  constructor(
    private host: Container,
    private tooltip: Tooltip,
    /** Pointer hit radius (ModuleView fattens it in touch mode; default 20). */
    private hitRadius: () => number = () => 20,
  ) {}

  clear(): void {
    this.centers.clear();
    this.dots.clear();
    this.types.clear();
  }

  /** (Re)place every pole; `rightX` is the tile width (outputs hug it). The
   * caller has already removed the old dot children. */
  build(poles: Pole[], rightX: number): void {
    this.clear();
    const place = (list: Pole[], x: number): void => {
      list.forEach((pole, i) => {
        const y = TITLE_H + 18 + i * 26;
        this.centers.set(pole.key, { x, y });
        this.types.set(pole.key, pole.type);
        const dot = new Graphics();
        drawDot(dot, pole.type, false);
        dot.position.set(x, y);
        dot.eventMode = 'static';
        dot.cursor = 'crosshair';
        dot.hitArea = {
          contains: (px: number, py: number) => {
            const r = this.hitRadius();
            return px * px + py * py < r * r;
          },
        };
        dot.on('pointerdown', (e) => {
          e.stopPropagation();
          pole.onDown(e);
        });
        dot.on('pointerup', (e) => {
          e.stopPropagation();
          pole.onUp(e);
        });
        dot.on('pointerover', (e) => this.tooltip.show(pole.tooltip(), e.clientX, e.clientY));
        dot.on('pointerout', () => this.tooltip.hide());
        this.host.addChild(dot);
        this.dots.set(pole.key, dot);
      });
    };
    place(poles.filter((p) => p.direction === 'in'), 0);
    place(poles.filter((p) => p.direction === 'out'), rightX);
  }

  setHighlight(key: string, on: boolean): void {
    const dot = this.dots.get(key);
    const type = this.types.get(key);
    if (dot && type !== undefined) drawDot(dot, type, on);
  }

  dot(key: string): Graphics | undefined {
    return this.dots.get(key);
  }

  center(key: string): { x: number; y: number } | undefined {
    return this.centers.get(key);
  }

  has(key: string): boolean {
    return this.centers.has(key);
  }

  /** True if a tile-local point sits on any pole dot (resize yields to poles). */
  overPole(px: number, py: number, r = 20): boolean {
    for (const c of this.centers.values()) {
      const dx = px - c.x;
      const dy = py - c.y;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }
}

/** Typed port dot; grows + whitens its ring when highlighted. */
export function drawDot(dot: Graphics, type: PortType, highlight: boolean): void {
  dot.clear();
  dot
    .circle(0, 0, highlight ? PORT_RADIUS + 3 : PORT_RADIUS)
    .fill(PORT_TYPE_COLORS[type])
    .stroke({ width: 2, color: highlight ? 0xffffff : 0x16161c });
}
