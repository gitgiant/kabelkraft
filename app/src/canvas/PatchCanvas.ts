/**
 * The patch canvas: PixiJS world with pan/zoom, module tiles in the
 * foreground, wires rendered behind them (PRD §5, §11), live wire drag with
 * snap, signal-reactive wire pulsing (PRD §4.4), module groups with
 * collapse/expand (PRD §6), multi-select and undo-aware drags.
 */

import { Application, Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import type { ModuleGroup, PortRef, Wire } from '../core/graph';
import { PORT_TYPE_COLORS } from '../core/types';
import { appState } from '../state';
import { onThemeChange, theme } from '../theme';
import { GroupView, type BoundaryPort } from './GroupView';
import { ModuleView } from './ModuleView';
import { Tooltip } from './Tooltip';


const NOTE_FLASH_MS = 250;

interface WireDrag {
  moduleId: string;
  portId: string;
  direction: 'in' | 'out';
  cursor: { x: number; y: number }; // world coords
}

interface ExpandedFrame {
  group: ModuleGroup;
  g: Graphics;
  title: Text;
}

export class PatchCanvas {
  private app = new Application();
  private world = new Container();
  private frameLayer = new Container(); // expanded group frames (back)
  private wireLayer = new Graphics(); // wires (middle)
  private moduleLayer = new Container(); // modules + group tiles (front)
  private rubberBand = new Graphics();
  private views = new Map<string, ModuleView>();
  private groupViews = new Map<string, GroupView>();
  private frames = new Map<string, ExpandedFrame>();
  private tooltip!: Tooltip;

  private wireDrag: WireDrag | null = null;
  private moduleDrag: { view: ModuleView; offsetX: number; offsetY: number } | null = null;
  private groupDrag: {
    view: GroupView;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
  } | null = null;
  private panning: { startX: number; startY: number; worldX: number; worldY: number } | null = null;
  private bandStart: { x: number; y: number } | null = null;

  async mount(container: HTMLElement): Promise<void> {
    await this.app.init({ background: theme.canvasBg, resizeTo: container, antialias: true });
    container.appendChild(this.app.canvas);
    this.tooltip = new Tooltip(container);

    this.world.addChild(this.frameLayer);
    this.world.addChild(this.wireLayer); // wires behind modules (PRD §5)
    this.world.addChild(this.moduleLayer);
    this.world.addChild(this.rubberBand);
    this.app.stage.addChild(this.world);
    this.world.position.set(this.app.screen.width / 2, this.app.screen.height / 2);

    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = { contains: () => true };
    this.app.stage.on('pointerdown', (e) => this.onStageDown(e));
    this.app.stage.on('pointermove', (e) => this.onStageMove(e));
    this.app.stage.on('pointerup', () => this.cancelDrags());
    this.app.stage.on('pointerupoutside', () => this.cancelDrags());
    this.app.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    window.addEventListener('keydown', (e) => this.onKeyDown(e));

    appState.on('graphChanged', () => this.syncViews());
    appState.on('projectLoaded', () => this.rebuildAll());
    appState.on('paramChanged', () => {
      for (const v of this.views.values()) v.refreshParams();
    });
    appState.on('sampleLoaded', () => {
      for (const v of this.views.values()) v.refreshSample();
    });
    appState.on('selectionChanged', () => {
      for (const [id, v] of this.views) v.setSelected(appState.selectedModuleIds.has(id));
    });
    onThemeChange(() => {
      this.app.renderer.background.color = theme.canvasBg;
      this.rebuildAll();
    });

    this.app.ticker.add(() => this.tick());
    this.syncViews();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      appState.deleteSelection();
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) appState.redo();
      else appState.undo();
    } else if (mod && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      if (e.shiftKey) {
        for (const gid of [...appState.selectedGroupIds]) appState.ungroup(gid);
      } else {
        appState.groupSelection();
      }
    }
  }

  /** World coordinates of the current view center — used to place new modules. */
  viewCenter(): { x: number; y: number } {
    const cx = (this.app.screen.width / 2 - this.world.position.x) / this.world.scale.x;
    const cy = (this.app.screen.height / 2 - this.world.position.y) / this.world.scale.y;
    return { x: cx, y: cy };
  }

  // -- view lifecycle -------------------------------------------------------

  private rebuildAll(): void {
    for (const view of this.views.values()) view.destroy({ children: true });
    this.views.clear();
    this.syncViews();
  }

  private syncViews(): void {
    const graph = appState.graph;

    for (const [id, view] of [...this.views]) {
      if (!graph.modules.has(id)) {
        view.destroy({ children: true });
        this.views.delete(id);
      }
    }
    for (const inst of graph.modules.values()) {
      if (this.views.has(inst.id)) continue;
      const def = graph.def(inst.type);
      const view = new ModuleView(inst, def, {
        onPortDown: (m, p, e) => this.startWireDrag(m, p, e),
        onPortUp: (m, p) => this.finishWireDrag(m, p),
        onBodyDown: (v, e) => this.startModuleDrag(v, e),
      }, this.tooltip);
      this.moduleLayer.addChild(view);
      this.views.set(inst.id, view);
      this.resolveCollisions(view); // newly placed modules must not overlap (PRD §5)
    }

    // Group tiles and frames are few — rebuild from scratch each change.
    for (const gv of this.groupViews.values()) gv.destroy({ children: true });
    this.groupViews.clear();
    for (const frame of this.frames.values()) {
      frame.g.destroy();
      frame.title.destroy();
    }
    this.frames.clear();

    for (const group of graph.groups.values()) {
      if (graph.groupHiddenBehind(group.id)) continue; // inside a collapsed ancestor
      if (group.collapsed) {
        const view = new GroupView(group, this.boundaryPorts(group), {
          onPortDown: (m, p, e) => this.startWireDrag(m, p, e),
          onPortUp: (m, p) => this.finishWireDrag(m, p),
          onBodyDown: (v, e) => this.startGroupDrag(v, e),
          onToggleCollapse: (id) => appState.toggleGroupCollapsed(id),
        }, this.tooltip);
        this.moduleLayer.addChild(view);
        this.groupViews.set(group.id, view);
      } else {
        const g = new Graphics();
        const title = new Text({
          text: `▣ ${group.name}  ▾`,
          style: { fontSize: 12, fill: theme.textDim, fontWeight: 'bold' },
        });
        title.eventMode = 'static';
        title.cursor = 'pointer';
        title.on('pointertap', () => appState.toggleGroupCollapsed(group.id));
        this.frameLayer.addChild(g);
        this.frameLayer.addChild(title);
        this.frames.set(group.id, { group, g, title });
      }
    }

    // Visibility: modules hidden behind a collapsed group don't render.
    for (const [id, view] of this.views) {
      view.visible = !graph.hiddenBehind(id);
    }
  }

  /** Member ports with wires crossing the group boundary (PRD §6). */
  private boundaryPorts(group: ModuleGroup): BoundaryPort[] {
    const graph = appState.graph;
    const members = graph.modulesInGroup(group.id);
    const seen = new Map<string, BoundaryPort>();
    for (const wire of graph.wires.values()) {
      const fromIn = members.has(wire.from.moduleId);
      const toIn = members.has(wire.to.moduleId);
      if (fromIn === toIn) continue;
      const inner = fromIn ? wire.from : wire.to;
      const direction = fromIn ? 'out' : 'in';
      const key = `${inner.moduleId}:${inner.portId}`;
      if (seen.has(key)) continue;
      const spec = graph.port(inner);
      seen.set(key, {
        key,
        moduleId: inner.moduleId,
        portId: inner.portId,
        direction,
        type: wire.type,
        label: spec?.label ?? inner.portId,
      });
    }
    return [...seen.values()];
  }

  // -- wire dragging ----------------------------------------------------------

  private startWireDrag(moduleId: string, portId: string, e: FederatedPointerEvent): void {
    const port = appState.graph.port({ moduleId, portId });
    if (!port) return;
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
      if (!view.visible) continue;
      for (const port of view.def.ports) {
        if (!on) {
          view.setPortHighlight(port.id, false);
          continue;
        }
        const drag = this.wireDrag!;
        const [from, to] = this.orient(drag, { moduleId: view.instance.id, portId: port.id });
        view.setPortHighlight(port.id, appState.graph.canConnect(from, to).ok);
      }
    }
    for (const gv of this.groupViews.values()) {
      for (const port of gv.boundary) {
        if (!on) {
          gv.setPortHighlight(port.key, port.type, false);
          continue;
        }
        const drag = this.wireDrag!;
        const [from, to] = this.orient(drag, { moduleId: port.moduleId, portId: port.portId });
        gv.setPortHighlight(port.key, port.type, appState.graph.canConnect(from, to).ok);
      }
    }
  }

  // -- module / group dragging -------------------------------------------------

  private startModuleDrag(view: ModuleView, e: FederatedPointerEvent): void {
    e.stopPropagation();
    appState.beginUndoable(); // whole drag = one undo step
    const p = this.world.toLocal(e.global);
    this.moduleDrag = { view, offsetX: p.x - view.position.x, offsetY: p.y - view.position.y };
    if (e.shiftKey) {
      appState.addToSelection({ moduleId: view.instance.id }, true);
    } else if (!appState.selectedModuleIds.has(view.instance.id)) {
      appState.select({ moduleId: view.instance.id });
    }
    this.moduleLayer.setChildIndex(view, this.moduleLayer.children.length - 1);
  }

  private startGroupDrag(view: GroupView, e: FederatedPointerEvent): void {
    e.stopPropagation();
    appState.beginUndoable();
    const p = this.world.toLocal(e.global);
    this.groupDrag = {
      view,
      offsetX: p.x - view.position.x,
      offsetY: p.y - view.position.y,
      startX: view.position.x,
      startY: view.position.y,
    };
    if (e.shiftKey) appState.addToSelection({ groupId: view.group.id }, true);
    else appState.select({ groupId: view.group.id });
  }

  /** Keep modules from overlapping (PRD §5): push the dropped module out. */
  private resolveCollisions(view: ModuleView): void {
    const margin = 10;
    for (let iter = 0; iter < 8; iter++) {
      let pushed = false;
      for (const other of this.views.values()) {
        if (other === view || !other.visible) continue;
        const ax = view.position.x, ay = view.position.y, aw = view.def.width, ah = view.def.height;
        const bx = other.position.x, by = other.position.y, bw = other.def.width, bh = other.def.height;
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
    if (e.shiftKey) {
      this.bandStart = this.world.toLocal(e.global);
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
      const view = this.moduleDrag.view;
      const nx = p.x - this.moduleDrag.offsetX;
      const ny = p.y - this.moduleDrag.offsetY;
      const dx = nx - view.position.x;
      const dy = ny - view.position.y;
      view.position.set(nx, ny);
      // Dragging a multi-selected module moves the whole selection.
      if (appState.selectedModuleIds.size > 1 && appState.selectedModuleIds.has(view.instance.id)) {
        for (const id of appState.selectedModuleIds) {
          if (id === view.instance.id) continue;
          const other = this.views.get(id);
          if (other) other.position.set(other.position.x + dx, other.position.y + dy);
        }
      }
    } else if (this.groupDrag) {
      const p = this.world.toLocal(e.global);
      this.groupDrag.view.position.set(p.x - this.groupDrag.offsetX, p.y - this.groupDrag.offsetY);
    } else if (this.panning) {
      this.world.position.set(
        this.panning.worldX + (e.global.x - this.panning.startX),
        this.panning.worldY + (e.global.y - this.panning.startY),
      );
    } else if (this.bandStart) {
      const p = this.world.toLocal(e.global);
      this.rubberBand
        .clear()
        .rect(
          Math.min(this.bandStart.x, p.x),
          Math.min(this.bandStart.y, p.y),
          Math.abs(p.x - this.bandStart.x),
          Math.abs(p.y - this.bandStart.y),
        )
        .fill({ color: 0x4488ff, alpha: 0.12 })
        .stroke({ width: 1, color: 0x4488ff, alpha: 0.7 });
    }
  }

  private cancelDrags(): void {
    if (this.wireDrag) {
      this.wireDrag = null;
      this.highlightCompatiblePorts(false);
    }
    if (this.moduleDrag) {
      this.resolveCollisions(this.moduleDrag.view);
      // Persist positions of every multi-dragged module.
      for (const id of appState.selectedModuleIds) {
        const v = this.views.get(id);
        if (v) {
          v.instance.x = v.position.x;
          v.instance.y = v.position.y;
        }
      }
      this.moduleDrag = null;
    }
    if (this.groupDrag) {
      const { view, startX, startY } = this.groupDrag;
      const dx = view.position.x - startX;
      const dy = view.position.y - startY;
      view.group.x = view.position.x;
      view.group.y = view.position.y;
      // Members travel with the collapsed tile so expand stays nearby.
      for (const id of appState.graph.modulesInGroup(view.group.id)) {
        const m = appState.graph.modules.get(id);
        if (m) {
          m.x += dx;
          m.y += dy;
        }
      }
      this.groupDrag = null;
    }
    if (this.bandStart) {
      const band = this.rubberBand.getLocalBounds();
      this.rubberBand.clear();
      if (band.width > 4 && band.height > 4) {
        for (const [id, view] of this.views) {
          if (!view.visible) continue;
          const vx = view.position.x;
          const vy = view.position.y;
          if (
            vx + view.def.width > band.x && vx < band.x + band.width &&
            vy + view.def.height > band.y && vy < band.y + band.height
          ) {
            appState.addToSelection({ moduleId: id });
          }
        }
        for (const [id, gv] of this.groupViews) {
          const gx = gv.position.x;
          const gy = gv.position.y;
          if (
            gx + gv.tileWidth > band.x && gx < band.x + band.width &&
            gy + gv.tileHeight > band.y && gy < band.y + band.height
          ) {
            appState.addToSelection({ groupId: id });
          }
        }
      }
      this.bandStart = null;
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

  /** Resolve a wire endpoint to a visible anchor: module port or group proxy. */
  private endpointPosition(ref: PortRef): { x: number; y: number } | null {
    const hiddenIn = appState.graph.hiddenBehind(ref.moduleId);
    if (hiddenIn) {
      const gv = this.groupViews.get(hiddenIn.id);
      if (!gv) return null;
      return (
        gv.portWorldPosition(`${ref.moduleId}:${ref.portId}`) ?? {
          x: gv.position.x + gv.tileWidth / 2,
          y: gv.position.y + gv.tileHeight / 2,
        }
      );
    }
    const view = this.views.get(ref.moduleId);
    return view ? view.portWorldPosition(ref.portId) : null;
  }

  private wirePath(wire: Wire): Array<{ x: number; y: number }> | null {
    const a = this.endpointPosition(wire.from);
    const b = this.endpointPosition(wire.to);
    if (!a || !b) return null;
    // Both endpoints inside the same collapsed group: internal wire, hidden.
    if (a.x === b.x && a.y === b.y) return null;
    return this.bezierPoints(a, b);
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
      const points = this.wirePath(wire);
      if (!points) continue;
      for (const pt of points) {
        if (Math.hypot(pt.x - p.x, pt.y - p.y) < threshold) return wire;
      }
    }
    return null;
  }

  private drawFrames(): void {
    for (const { group, g, title } of this.frames.values()) {
      // Bounding box over visible member views (modules + nested group tiles).
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const include = (x: number, y: number, w: number, h: number) => {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
      };
      for (const id of group.moduleIds) {
        const v = this.views.get(id);
        if (v && v.visible) include(v.position.x, v.position.y, v.def.width, v.def.height);
      }
      for (const gid of group.groupIds) {
        const gv = this.groupViews.get(gid);
        if (gv) include(gv.position.x, gv.position.y, gv.tileWidth, gv.tileHeight);
        const f = this.frames.get(gid);
        if (f) {
          const b = f.g.getLocalBounds();
          if (b.width > 0) include(b.x, b.y, b.width, b.height);
        }
      }
      g.clear();
      if (!Number.isFinite(minX)) continue;
      const pad = 24;
      g.roundRect(minX - pad, minY - pad - 16, maxX - minX + pad * 2, maxY - minY + pad * 2 + 16, 14)
        .fill({ color: group.color ?? theme.frameFill, alpha: 0.35 })
        .stroke({ width: 1.5, color: group.color ?? theme.groupStroke, alpha: 0.8 });
      title.position.set(minX - pad + 10, minY - pad - 10);
    }
  }

  private tick(): void {
    const now = performance.now();
    this.wireLayer.clear();
    this.drawFrames();

    for (const wire of appState.graph.wires.values()) {
      const points = this.wirePath(wire);
      if (!points) continue;

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
      } else if (wire.type === 'control') {
        // Glow proportional to the live control value (PRD §4.4).
        const v = appState.controlValues[wire.from.moduleId];
        if (v !== undefined) {
          alpha = 0.3 + 0.6 * v;
          width = 2 + 2 * v;
        }
      }

      if (wire.id === appState.selectedWireId) {
        this.strokePath(points, width + 4, 0xffffff, 0.25);
      }
      this.strokePath(points, width, color, alpha);
    }

    // Live wire being dragged.
    if (this.wireDrag) {
      const a = this.endpointPosition({ moduleId: this.wireDrag.moduleId, portId: this.wireDrag.portId });
      if (a) {
        const b = this.wireDrag.cursor;
        const [start, end] = this.wireDrag.direction === 'out' ? [a, b] : [b, a];
        const port = appState.graph.port({ moduleId: this.wireDrag.moduleId, portId: this.wireDrag.portId });
        if (port) {
          this.strokePath(this.bezierPoints(start, end), 2.5, PORT_TYPE_COLORS[port.type], 0.9);
        }
      }
    }

    for (const view of this.views.values()) {
      if (view.visible) view.updateLive();
    }
  }

  private strokePath(points: Array<{ x: number; y: number }>, width: number, color: number, alpha: number): void {
    this.wireLayer.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) this.wireLayer.lineTo(points[i].x, points[i].y);
    this.wireLayer.stroke({ width, color, alpha, cap: 'round', join: 'round' });
  }
}

export const patchCanvas = new PatchCanvas();
