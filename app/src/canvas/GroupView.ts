/**
 * Module group visuals (PRD §6): a collapsed group renders as a single tile
 * whose ports proxy the member ports that have wires crossing the group
 * boundary; an expanded group renders as a frame behind its members with a
 * title bar and a collapse button.
 */

import { Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import type { ModuleGroup } from '../core/graph';
import { PORT_TYPE_COLORS, type PortType } from '../core/types';
import { appState } from '../state';
import { theme } from '../theme';
import { PORT_RADIUS } from './ModuleView';
import type { Tooltip } from './Tooltip';

const TITLE_H = 24;

export interface BoundaryPort {
  key: string; // `${moduleId}:${portId}`
  moduleId: string;
  portId: string;
  direction: 'in' | 'out';
  type: PortType;
  label: string;
}

export interface GroupHandlers {
  onPortDown(moduleId: string, portId: string, e: FederatedPointerEvent): void;
  onPortUp(moduleId: string, portId: string, e: FederatedPointerEvent): void;
  onBodyDown(view: GroupView, e: FederatedPointerEvent): void;
  onToggleCollapse(groupId: string): void;
}

export class GroupView extends Container {
  /** World positions of proxy ports keyed by `${moduleId}:${portId}`. */
  private portCenters = new Map<string, { x: number; y: number }>();
  private portDots = new Map<string, Graphics>();
  tileWidth = 170;
  tileHeight = 80;

  constructor(
    readonly group: ModuleGroup,
    private boundaryPorts: BoundaryPort[],
    private handlers: GroupHandlers,
    private tooltip: Tooltip,
  ) {
    super();
    if (group.collapsed) this.buildCollapsedTile();
    // Expanded frame is drawn by the canvas each tick (it must track member
    // positions); this view only renders the collapsed tile.
  }

  private buildCollapsedTile(): void {
    const inputs = this.boundaryPorts.filter((p) => p.direction === 'in');
    const outputs = this.boundaryPorts.filter((p) => p.direction === 'out');
    const rows = Math.max(inputs.length, outputs.length, 1);
    this.tileHeight = TITLE_H + 18 + rows * 26;
    const w = this.tileWidth;
    const h = this.tileHeight;
    this.position.set(this.group.x, this.group.y);

    const body = new Graphics()
      .roundRect(0, 0, w, h, 10)
      .fill(theme.groupBody)
      .stroke({ width: 2, color: this.group.color ?? theme.groupStroke });
    body.roundRect(0, 0, w, TITLE_H, 10).fill(theme.groupTitle);
    body.rect(0, TITLE_H - 8, w, 8).fill(theme.groupTitle);
    body.eventMode = 'static';
    body.cursor = 'grab';
    body.on('pointerdown', (e) => this.handlers.onBodyDown(this, e));
    // Double-click expands (PRD §6).
    let lastTap = 0;
    body.on('pointertap', () => {
      const now = performance.now();
      if (now - lastTap < 350) this.handlers.onToggleCollapse(this.group.id);
      lastTap = now;
    });
    body.on('pointerover', (e) =>
      this.tooltip.show(
        [this.group.name, `Module group — ${appState.graph.modulesInGroup(this.group.id).size} modules. Double-click to open.`],
        e.clientX,
        e.clientY,
      ),
    );
    body.on('pointerout', () => this.tooltip.hide());
    this.addChild(body);

    const title = new Text({
      text: `▣ ${this.group.name}`,
      style: { fontSize: 12, fill: theme.text, fontWeight: 'bold' },
    });
    title.position.set(8, 5);
    title.eventMode = 'none';
    this.addChild(title);

    const place = (ports: BoundaryPort[], x: number) => {
      ports.forEach((port, i) => {
        const y = TITLE_H + 18 + i * 26;
        this.portCenters.set(port.key, { x, y });
        const dot = new Graphics();
        this.drawDot(dot, port.type, false);
        dot.position.set(x, y);
        dot.eventMode = 'static';
        dot.cursor = 'crosshair';
        dot.hitArea = { contains: (px: number, py: number) => px * px + py * py < 20 * 20 };
        dot.on('pointerdown', (e) => {
          e.stopPropagation();
          this.handlers.onPortDown(port.moduleId, port.portId, e);
        });
        dot.on('pointerup', (e) => {
          e.stopPropagation();
          this.handlers.onPortUp(port.moduleId, port.portId, e);
        });
        dot.on('pointerover', (e) => {
          const mod = appState.graph.modules.get(port.moduleId);
          this.tooltip.show(
            [`${port.label} — ${port.type} ${port.direction}`, `Inside: ${mod?.label ?? mod?.type ?? port.moduleId}`],
            e.clientX,
            e.clientY,
          );
        });
        dot.on('pointerout', () => this.tooltip.hide());
        this.addChild(dot);
        this.portDots.set(port.key, dot);
      });
    };
    place(inputs, 0);
    place(outputs, w);
  }

  private drawDot(dot: Graphics, type: PortType, highlight: boolean): void {
    dot.clear();
    dot
      .circle(0, 0, highlight ? PORT_RADIUS + 3 : PORT_RADIUS)
      .fill(PORT_TYPE_COLORS[type])
      .stroke({ width: 2, color: highlight ? 0xffffff : 0x16161c });
  }

  setPortHighlight(key: string, type: PortType, on: boolean): void {
    const dot = this.portDots.get(key);
    if (dot) this.drawDot(dot, type, on);
  }

  get boundary(): BoundaryPort[] {
    return this.boundaryPorts;
  }

  hasPort(key: string): boolean {
    return this.portCenters.has(key);
  }

  portWorldPosition(key: string): { x: number; y: number } | null {
    const local = this.portCenters.get(key);
    if (!local) return null;
    return { x: this.position.x + local.x, y: this.position.y + local.y };
  }
}

export { TITLE_H as GROUP_TITLE_H };
