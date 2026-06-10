/**
 * The patch canvas: PixiJS world with pan/zoom, module tiles in the
 * foreground, wires rendered behind them (PRD §5, §11), live wire drag with
 * snap, signal-reactive wire pulsing (PRD §4.4).
 */

import { Application, Container, FederatedPointerEvent, Graphics } from 'pixi.js';
import type { PortRef, Wire } from '../core/graph';
import { PORT_TYPE_COLORS } from '../core/types';
import { appState } from '../state';
import { ModuleView, PORT_RADIUS } from './ModuleView';
import { Tooltip } from './Tooltip';

const BG_COLOR = 0x17171c;
const NOTE_FLASH_MS = 250;

interface WireDrag {
  moduleId: string;
  portId: string;
  direction: 'in' | 'out';
  cursor: { x: number; y: number }; // world coords
}

export class PatchCanvas {
  private app = new Application();
  private world = new Container();
  private wireLayer = new Graphics();
  private moduleLayer = new Container();
  private views = new Map<string, ModuleView>();
  private tooltip!: Tooltip;

  private wireDrag: WireDrag | null = null;
  private moduleDrag: { view: ModuleView; offsetX: number; offsetY: number } | null = null;
  private panning: { startX: number; startY: number; worldX: number; worldY: number } | null = null;

  async mount(container: HTMLElement): Promise<void> {
    await this.app.init({ background: BG_COLOR, resizeTo: container, antialias: true });
    container.appendChild(this.app.canvas);
    this.tooltip = new Tooltip(container);

    this.world.addChild(this.wireLayer); // wires behind...
    this.world.addChild(this.moduleLayer); // ...modules in front (PRD §5)
    this.app.stage.addChild(this.world);
    this.world.position.set(this.app.screen.width / 2, this.app.screen.height / 2);

    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = { contains: () => true };
    this.app.stage.on('pointerdown', (e) => this.onStageDown(e));
    this.app.stage.on('pointermove', (e) => this.onStageMove(e));
    this.app.stage.on('pointerup', (e) => this.onStageUp(e));
    this.app.stage.on('pointerupoutside', () => this.cancelDrags());
    this.app.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') appState.deleteSelection();
      }
    });

    appState.on('graphChanged', () => this.syncViews());
    appState.on('paramChanged', () => {
      for (const v of this.views.values()) v.refreshParams();
    });
    appState.on('selectionChanged', () => {
      for (const [id, v] of this.views) v.setSelected(id === appState.selectedModuleId);
    });

    this.app.ticker.add(() => this.tick());
    this.syncViews();
  }

  /** World coordinates of the current view center — used to place new modules. */
  viewCenter(): { x: number; y: number } {
    const cx = (this.app.screen.width / 2 - this.world.position.x) / this.world.scale.x;
    const cy = (this.app.screen.height / 2 - this.world.position.y) / this.world.scale.y;
    return { x: cx, y: cy };
  }

  // -- view lifecycle -------------------------------------------------------

  private syncViews(): void {
    for (const [id, view] of [...this.views]) {
      if (!appState.graph.modules.has(id)) {
        view.destroy({ children: true });
        this.views.delete(id);
      }
    }
    for (const inst of appState.graph.modules.values()) {
      if (this.views.has(inst.id)) continue;
      const def = appState.graph.def(inst.type);
      const view = new ModuleView(inst, def, {
        onPortDown: (m, p, e) => this.startWireDrag(m, p, e),
        onPortUp: (m, p) => this.finishWireDrag(m, p),
        onBodyDown: (v, e) => this.startModuleDrag(v, e),
      }, this.tooltip);
      this.moduleLayer.addChild(view);
      this.views.set(inst.id, view);
    }
  }

  // -- wire dragging ----------------------------------------------------------

  private startWireDrag(moduleId: string, portId: string, e: FederatedPointerEvent): void {
    const view = this.views.get(moduleId);
    const port = view?.def.ports.find((p) => p.id === portId);
    if (!view || !port) return;
    const cursor = this.world.toLocal(e.global);
    this.wireDrag = { moduleId, portId, direction: port.direction, cursor };
    this.highlightCompatiblePorts(true);
  }

  private finishWireDrag(moduleId: string, portId: string): void {
    if (!this.wireDrag) return;
    const drag = this.wireDrag;
    this.wireDrag = null;
    this.highlightCompatiblePorts(false);
    if (drag.moduleId === moduleId && drag.portId === portId) return; // same port

    const [from, to] = this.orient(drag, { moduleId, portId });
    const result = appState.connect(from, to);
    if (!result.ok) {
      this.views.get(moduleId)?.flashPortRejection(portId);
      this.tooltip.hide();
    }
  }

  /** Orient a drag pair into (output, input) order based on drag direction. */
  private orient(drag: WireDrag, other: PortRef): [PortRef, PortRef] {
    const dragRef = { moduleId: drag.moduleId, portId: drag.portId };
    return drag.direction === 'out' ? [dragRef, other] : [other, dragRef];
  }

  private highlightCompatiblePorts(on: boolean): void {
    for (const view of this.views.values()) {
      for (const port of view.def.ports) {
        if (!on) {
          view.setPortHighlight(port.id, false);
          continue;
        }
        const drag = this.wireDrag!;
        const [from, to] = this.orient(drag, { moduleId: view.instance.id, portId: port.id });
        const ok = appState.graph.canConnect(from, to).ok;
        view.setPortHighlight(port.id, ok);
      }
    }
  }

  // -- module dragging --------------------------------------------------------

  private startModuleDrag(view: ModuleView, e: FederatedPointerEvent): void {
    e.stopPropagation();
    const p = this.world.toLocal(e.global);
    this.moduleDrag = { view, offsetX: p.x - view.position.x, offsetY: p.y - view.position.y };
    appState.select({ moduleId: view.instance.id });
    this.moduleLayer.setChildIndex(view, this.moduleLayer.children.length - 1);
  }

  /** Keep modules from overlapping (PRD §5): push the dropped module out. */
  private resolveCollisions(view: ModuleView): void {
    const margin = 10;
    for (let iter = 0; iter < 8; iter++) {
      let pushed = false;
      for (const other of this.views.values()) {
        if (other === view) continue;
        const a = view, b = other;
        const ax = a.position.x, ay = a.position.y, aw = a.def.width, ah = a.def.height;
        const bx = b.position.x, by = b.position.y, bw = b.def.width, bh = b.def.height;
        const overlapX = Math.min(ax + aw + margin, bx + bw + margin) - Math.max(ax - margin, bx - margin);
        const overlapY = Math.min(ay + ah + margin, by + bh + margin) - Math.max(ay - margin, by - margin);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            view.position.x += ax + aw / 2 < bx + bw / 2 ? -overlapX : overlapX;
          } else {
            view.position.y += ay + ah / 2 < by + bh / 2 ? -overlapY : overlapY;
          }
          pushed = true;
        }
      }
      if (!pushed) break;
    }
    view.instance.x = view.position.x;
    view.instance.y = view.position.y;
  }

  // -- stage events ------------------------------------------------------------

  private onStageDown(e: FederatedPointerEvent): void {
    // Reaches here only when nothing interactive consumed it: empty canvas.
    const wire = this.hitTestWire(e);
    if (wire) {
      appState.select({ wireId: wire.id });
      return;
    }
    appState.select(null);
    this.panning = {
      startX: e.global.x,
      startY: e.global.y,
      worldX: this.world.position.x,
      worldY: this.world.position.y,
    };
  }

  private onStageMove(e: FederatedPointerEvent): void {
    if (this.wireDrag) {
      this.wireDrag.cursor = this.world.toLocal(e.global);
    } else if (this.moduleDrag) {
      const p = this.world.toLocal(e.global);
      this.moduleDrag.view.position.set(p.x - this.moduleDrag.offsetX, p.y - this.moduleDrag.offsetY);
    } else if (this.panning) {
      this.world.position.set(
        this.panning.worldX + (e.global.x - this.panning.startX),
        this.panning.worldY + (e.global.y - this.panning.startY),
      );
    }
  }

  private onStageUp(_e: FederatedPointerEvent): void {
    this.cancelDrags();
  }

  private cancelDrags(): void {
    if (this.wireDrag) {
      this.wireDrag = null;
      this.highlightCompatiblePorts(false);
    }
    if (this.moduleDrag) {
      this.resolveCollisions(this.moduleDrag.view);
      this.moduleDrag = null;
    }
    this.panning = null;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(2.5, Math.max(0.2, this.world.scale.x * factor));
    const rect = this.app.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const wx = (px - this.world.position.x) / this.world.scale.x;
    const wy = (py - this.world.position.y) / this.world.scale.y;
    this.world.scale.set(next);
    this.world.position.set(px - wx * next, py - wy * next);
  }

  // -- wire rendering --------------------------------------------------------

  private wirePath(wire: Wire): { points: Array<{ x: number; y: number }> } | null {
    const fromView = this.views.get(wire.from.moduleId);
    const toView = this.views.get(wire.to.moduleId);
    if (!fromView || !toView) return null;
    const a = fromView.portWorldPosition(wire.from.portId);
    const b = toView.portWorldPosition(wire.to.portId);
    return { points: this.bezierPoints(a, b) };
  }

  private bezierPoints(a: { x: number; y: number }, b: { x: number; y: number }) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const handle = Math.min(200, Math.max(30, dist * 0.45));
    const c1 = { x: a.x + handle, y: a.y };
    const c2 = { x: b.x - handle, y: b.y };
    const points = [];
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      points.push({
        x: mt ** 3 * a.x + 3 * mt ** 2 * t * c1.x + 3 * mt * t ** 2 * c2.x + t ** 3 * b.x,
        y: mt ** 3 * a.y + 3 * mt ** 2 * t * c1.y + 3 * mt * t ** 2 * c2.y + t ** 3 * b.y,
      });
    }
    return points;
  }

  private hitTestWire(e: FederatedPointerEvent): Wire | null {
    const p = this.world.toLocal(e.global);
    const threshold = 8 / this.world.scale.x;
    for (const wire of appState.graph.wires.values()) {
      const path = this.wirePath(wire);
      if (!path) continue;
      for (const pt of path.points) {
        if (Math.hypot(pt.x - p.x, pt.y - p.y) < threshold) return wire;
      }
    }
    return null;
  }

  private tick(): void {
    const now = performance.now();
    this.wireLayer.clear();

    for (const wire of appState.graph.wires.values()) {
      const path = this.wirePath(wire);
      if (!path) continue;

      let color = wire.color ?? PORT_TYPE_COLORS[wire.type];
      let alpha = 0.35;
      let width = 2;

      if (wire.type === 'audio') {
        // Pulse with the actual signal (PRD §4.4): source module's meter.
        const meter = appState.meters[wire.from.moduleId];
        if (meter) {
          alpha = 0.35 + Math.min(0.65, meter.rms * 2.2);
          width = 2 + Math.min(4, meter.peak * 4);
        }
      } else if (wire.type === 'note') {
        const flash = appState.noteFlash.get(wire.from.moduleId);
        if (flash !== undefined && now - flash < NOTE_FLASH_MS) {
          const k = 1 - (now - flash) / NOTE_FLASH_MS;
          alpha = 0.35 + 0.65 * k;
          width = 2 + 3 * k;
        }
      }

      if (wire.id === appState.selectedWireId) {
        this.strokePath(path.points, width + 4, 0xffffff, 0.25);
      }
      this.strokePath(path.points, width, color, alpha);
    }

    // Live wire being dragged.
    if (this.wireDrag) {
      const view = this.views.get(this.wireDrag.moduleId);
      if (view) {
        const a = view.portWorldPosition(this.wireDrag.portId);
        const b = this.wireDrag.cursor;
        const [start, end] = this.wireDrag.direction === 'out' ? [a, b] : [b, a];
        const port = view.def.ports.find((p) => p.id === this.wireDrag!.portId)!;
        this.strokePath(this.bezierPoints(start, end), 2.5, PORT_TYPE_COLORS[port.type], 0.9);
      }
    }

    for (const view of this.views.values()) view.updateMeter();
  }

  private strokePath(points: Array<{ x: number; y: number }>, width: number, color: number, alpha: number): void {
    this.wireLayer.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) this.wireLayer.lineTo(points[i].x, points[i].y);
    this.wireLayer.stroke({ width, color, alpha, cap: 'round', join: 'round' });
  }
}

export const patchCanvas = new PatchCanvas();
