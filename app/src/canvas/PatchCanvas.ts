/**
 * The patch canvas: PixiJS world with pan/zoom, module tiles in the
 * foreground, wires rendered behind them (PRD §5, §11), live wire drag with
 * snap, signal-reactive wire pulsing (PRD §4.4), module groups with
 * collapse/expand (PRD §6), multi-select and undo-aware drags.
 */

import { Application, Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import type { ModuleGroup, PortRef, Wire } from '../core/graph';
import { isTouchMode } from '../core/mobile';
import { appSettings } from '../core/settings';
import { PORT_TYPE_COLORS } from '../core/types';
import { appState } from '../state';
import { nextGroupColor, onThemeChange, theme } from '../theme';
import { GroupView, type BoundaryPort } from './GroupView';
import { ModuleView, tickHiddenTintSource } from './ModuleView';
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
  ai: Text;
  rename: Text;
  swatch: Graphics;
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
  /** Wire anchors for expanded groups' intrinsic poles (set by drawFrames). */
  private frameAnchors = new Map<string, { x: number; y: number }>();
  /** In-flight position tweens (Arrange animation); advanced each tick. */
  private tweens: Array<{
    obj: { position: { x: number; y: number; set(x: number, y: number): void } };
    sx: number;
    sy: number;
    tx: number;
    ty: number;
    start: number;
    dur: number;
  }> = [];
  private lastTickAt = performance.now();
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
  // Dragging the background of an expanded group frame moves the whole group:
  // every member view + nested collapsed tile travels live; positions persist
  // on drop. dx/dy track the running delta for the model commit.
  private frameDrag: {
    group: ModuleGroup;
    start: { x: number; y: number };
    dx: number;
    dy: number;
    moduleStart: Map<string, { x: number; y: number }>;
    groupStart: Map<string, { x: number; y: number }>;
  } | null = null;
  private panning: { startX: number; startY: number; worldX: number; worldY: number } | null = null;
  private bandStart: { x: number; y: number } | null = null;
  private wireMoveDrag: { wire: Wire } | null = null;
  // Two-finger pinch: zoom (scale ratio) + pan (midpoint delta). Only armed
  // when no object drag is in flight, so it never hijacks a module/wire grab.
  private pinch: { dist: number; mid: { x: number; y: number } } | null = null;

  // -- touch-mode gesture state (see core/mobile.ts) --------------------------
  /** Long-press: toggles multi-select (module) or starts a rubber-band (canvas). */
  private longPress: {
    timer: number;
    global: { x: number; y: number };
    target: { kind: 'module'; view: ModuleView } | { kind: 'canvas' };
  } | null = null;
  /** Touch defers selection changes to pointerup so gestures can cancel them. */
  private pendingSelect: ModuleView | null = null;
  private pendingDeselect = false;
  /** Multi-finger tap tracking: two fingers = undo, three = redo. */
  private multiTap: { count: number; at: number; moved: boolean } | null = null;
  /** Pinch metrics at gesture start, to tell a multi-finger tap from a pinch. */
  private pinchStart: { dist: number; mid: { x: number; y: number } } | null = null;
  /** Swipe in from the canvas edge: left opens the palette, right the library. */
  private edgeSwipe: { side: 'left' | 'right'; startX: number } | null = null;
  /** Double-tap empty canvas = zoom-to-fit. */
  private lastCanvasTap = { at: 0, x: 0, y: 0 };

  // Drag-to-delete trash zone (screen-space overlay, shown during drags).
  private trash = new Container();
  private trashRect = { x: 0, y: 0, w: 132, h: 64 };
  private overTrash = false;

  async mount(container: HTMLElement): Promise<void> {
    // Bake text/textures at >1× device pixels so labels stay crisp when zoomed
    // in (max zoom 2.5×). autoDensity keeps CSS size correct; app.screen stays
    // in CSS px, so all coordinate math below is unaffected.
    await this.app.init({
      background: theme.canvasBg,
      resizeTo: container,
      antialias: true,
      resolution: Math.max(2.5, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    container.appendChild(this.app.canvas);
    this.tooltip = new Tooltip(container);

    this.world.addChild(this.frameLayer);
    this.world.addChild(this.wireLayer); // wires behind modules (PRD §5)
    this.world.addChild(this.moduleLayer);
    this.world.addChild(this.rubberBand);
    this.app.stage.addChild(this.world);
    this.world.position.set(this.app.screen.width / 2, this.app.screen.height / 2);

    this.buildTrash();
    this.app.stage.addChild(this.trash);

    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = { contains: () => true };
    this.app.stage.on('pointerdown', (e) => this.onStageDown(e));
    this.app.stage.on('pointermove', (e) => this.onStageMove(e));
    this.app.stage.on('pointerup', () => this.cancelDrags());
    this.app.stage.on('pointerupoutside', () => this.cancelDrags());
    this.app.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.app.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    this.app.canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    this.app.canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    this.app.canvas.addEventListener('touchcancel', () => this.onTouchCancel());
    this.app.renderer.on('resize', () => this.layoutTrash());
    // Pixi's resizeTo only reacts to *window* resizes; hiding the toolbar or
    // palette resizes the container without one, so observe it directly.
    new ResizeObserver(() => this.app.resize()).observe(container);

    window.addEventListener('keydown', (e) => this.onKeyDown(e));

    appState.on('graphChanged', () => {
      this.syncViews();
      // TODO(intelligence): placeholder face lists wired inputs — refresh on
      // wire changes (syncViews only adds/removes whole tiles).
      for (const v of this.views.values()) {
        if (v.instance.type === 'intelligence') v.rebuild();
      }
    });
    appState.on('projectLoaded', () => this.rebuildAll());
    appState.on('groupCollapseToggled', () => {
      // Opt-in: re-tidy the patch whenever a group expands/collapses so the
      // freed/needed space is reclaimed without a manual Arrange click.
      if (appSettings().general.autoArrangeOnToggle) this.autoArrange();
    });
    appState.on('composerChanged', () => {
      // Open/shrink resizes the composer tile (state mutates instance.w/h).
      for (const v of this.views.values()) {
        if (v.instance.type === 'composer') v.rebuild();
      }
    });
    appState.on('paramChanged', () => {
      // A synth whose mode changed needs a fresh face (mode-scoped params).
      let rebuilt = false;
      for (const [id, v] of [...this.views]) {
        if (v.faceStale()) {
          v.destroy({ children: true });
          this.views.delete(id);
          rebuilt = true;
        }
      }
      if (rebuilt) this.syncViews();
      for (const v of this.views.values()) v.refreshParams();
      for (const gv of this.groupViews.values()) gv.refreshParams();
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

  /**
   * Sample-library drop target at a client point: a Sampler, or a Drum
   * Machine pad (specific pad when the point is over the pad grid,
   * otherwise the pad currently selected on the module).
   */
  dropTargetAt(clientX: number, clientY: number): { moduleId: string; pad?: number } | null {
    const rect = this.app.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    const wx = (clientX - rect.left - this.world.position.x) / this.world.scale.x;
    const wy = (clientY - rect.top - this.world.position.y) / this.world.scale.y;
    for (const [id, view] of this.views) {
      if (!view.visible) continue;
      const lx = wx - view.position.x;
      const ly = wy - view.position.y;
      if (lx < 0 || ly < 0 || lx > view.w || ly > view.h) continue;
      if (view.instance.type === 'smpl') return { moduleId: id };
    }
    return null;
  }

  /** Client-space center of a module tile — canvas e2e drive their mouse with this. */
  clientPointFor(moduleId: string): { x: number; y: number } | null {
    const view = this.views.get(moduleId);
    if (!view) return null;
    const rect = this.app.canvas.getBoundingClientRect();
    return {
      x: rect.left + this.world.position.x + (view.position.x + view.w / 2) * this.world.scale.x,
      y: rect.top + this.world.position.y + (view.position.y + view.h / 2) * this.world.scale.y,
    };
  }

  /**
   * Client-space rect of a module tile (top-left + size in screen px), plus
   * whether it currently intersects the canvas viewport. Anchored panels
   * (composer piano roll) pin to this and hide when the module scrolls away.
   */
  clientRectFor(
    moduleId: string,
  ): { left: number; top: number; width: number; height: number; scale: number; onScreen: boolean } | null {
    const view = this.views.get(moduleId);
    const rect = this.app.canvas.getBoundingClientRect();
    const s = this.world.scale.x;
    let left: number;
    let top: number;
    let width: number;
    let height: number;
    let scale = s;
    if (view && view.visible) {
      left = rect.left + this.world.position.x + view.position.x * s;
      top = rect.top + this.world.position.y + view.position.y * s;
      width = view.w * s;
      height = view.h * s;
    } else {
      // Hidden inside a collapsed group — anchor onto a face 'view' embed
      // of this module instead, if one exists.
      let embed: { gv: GroupView; r: { x: number; y: number; w: number; h: number; scale: number } } | null = null;
      for (const gv of this.groupViews.values()) {
        const r = gv.embedRect(moduleId);
        if (r) {
          embed = { gv, r };
          break;
        }
      }
      if (!embed) return null;
      const { gv, r } = embed;
      scale = s * r.scale;
      left = rect.left + this.world.position.x + (gv.position.x + r.x) * s;
      top = rect.top + this.world.position.y + (gv.position.y + r.y) * s;
      width = r.w * scale;
      height = r.h * scale;
    }
    const onScreen =
      left + width > rect.left && left < rect.right && top + height > rect.top && top < rect.bottom;
    return { left, top, width, height, scale, onScreen };
  }

  /** Client-space center of a param's control widget (e2e + tools). */
  clientPointForParam(moduleId: string, paramId: string): { x: number; y: number } | null {
    const view = this.views.get(moduleId);
    const anchor = view?.paramAnchor(paramId);
    if (!view || !anchor) return null;
    const rect = this.app.canvas.getBoundingClientRect();
    return {
      x: rect.left + this.world.position.x + (view.position.x + anchor.x) * this.world.scale.x,
      y: rect.top + this.world.position.y + (view.position.y + anchor.y) * this.world.scale.y,
    };
  }

  /** Client position of a collapsed group tile's top-left corner (e2e + tools). */
  clientPointForGroup(groupId: string): { x: number; y: number } | null {
    const view = this.groupViews.get(groupId);
    if (!view) return null;
    const rect = this.app.canvas.getBoundingClientRect();
    return {
      x: rect.left + this.world.position.x + view.position.x * this.world.scale.x,
      y: rect.top + this.world.position.y + view.position.y * this.world.scale.y,
    };
  }

  /** Pan the view by client-space pixels (e2e + tools). */
  panBy(dx: number, dy: number): void {
    this.world.position.set(this.world.position.x + dx, this.world.position.y + dy);
  }

  /** World coordinates of the current view center — used to place new modules. */
  viewCenter(): { x: number; y: number } {
    const cx = (this.app.screen.width / 2 - this.world.position.x) / this.world.scale.x;
    const cy = (this.app.screen.height / 2 - this.world.position.y) / this.world.scale.y;
    return { x: cx, y: cy };
  }

  /** World point under a client coord, or null if outside the canvas (AI drag-drop). */
  worldFromClient(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.app.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    return {
      x: (clientX - rect.left - this.world.position.x) / this.world.scale.x,
      y: (clientY - rect.top - this.world.position.y) / this.world.scale.y,
    };
  }

  /**
   * Animate a freshly inserted AI patch popping in: the collapsed faced tile if
   * the group has a face, otherwise each member module.
   */
  popInImport(moduleIds: Iterable<string>, groupId?: string): void {
    const gv = groupId ? this.groupViews.get(groupId) : undefined;
    if (gv) {
      gv.popIn();
      return;
    }
    for (const id of moduleIds) this.views.get(id)?.popIn();
  }


  /** Glide a Pixi object's visual position to (tx, ty); replaces any tween on it. */
  private queueTween(
    obj: { position: { x: number; y: number; set(x: number, y: number): void } },
    tx: number,
    ty: number,
    dur = 320,
  ): void {
    this.tweens = this.tweens.filter((t) => t.obj !== obj);
    const { x: sx, y: sy } = obj.position;
    if (sx === tx && sy === ty) {
      obj.position.set(tx, ty);
      return;
    }
    this.tweens.push({ obj, sx, sy, tx, ty, start: performance.now(), dur });
  }

  /** Advance and retire active position tweens (easeInOutCubic). */
  private advanceTweens(now: number): void {
    if (this.tweens.length === 0) return;
    this.tweens = this.tweens.filter((t) => {
      const k = Math.min(1, (now - t.start) / t.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      t.obj.position.set(t.sx + (t.tx - t.sx) * e, t.sy + (t.ty - t.sy) * e);
      return k < 1;
    });
  }

  /**
   * Auto-arrange (toolbar): layered signal-flow layout. Nodes are visible
   * module tiles and collapsed group tiles; wires define left→right layers
   * (sources → effects → outputs). Unwired nodes park in a final column.
   * One undo step; the view re-centers on the result.
   */
  autoArrange(): void {
    const graph = appState.graph;
    interface ArrNode {
      id: string;
      w: number;
      h: number;
      y0: number;
      mv?: ModuleView;
      gv?: GroupView;
    }
    const nodes = new Map<string, ArrNode>();
    for (const [id, v] of this.views) {
      if (v.visible) nodes.set(id, { id, w: v.w, h: v.h, y0: v.position.y, mv: v });
    }
    for (const [id, gv] of this.groupViews) {
      nodes.set(id, { id, w: gv.tileWidth, h: gv.tileHeight, y0: gv.position.y, gv });
    }
    if (nodes.size === 0) return;
    appState.beginUndoable();

    // Wires between visible anchors (a hidden module anchors to its group tile).
    const anchorOf = (moduleId: string) => graph.hiddenBehind(moduleId)?.id ?? moduleId;
    const edges: Array<[string, string]> = [];
    const wired = new Set<string>();
    for (const wire of graph.wires.values()) {
      const a = anchorOf(wire.from.moduleId);
      const b = anchorOf(wire.to.moduleId);
      if (a === b || !nodes.has(a) || !nodes.has(b)) continue;
      edges.push([a, b]);
      wired.add(a);
      wired.add(b);
    }

    // Longest-path layering; iteration cap keeps feedback loops finite.
    const layer = new Map<string, number>();
    for (const id of nodes.keys()) layer.set(id, 0);
    for (let iter = 0; iter < nodes.size; iter++) {
      let changed = false;
      for (const [a, b] of edges) {
        const want = layer.get(a)! + 1;
        if (layer.get(b)! < want && want < nodes.size) {
          layer.set(b, want);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const maxWired = Math.max(0, ...[...wired].map((id) => layer.get(id)!));
    for (const id of nodes.keys()) {
      if (!wired.has(id)) layer.set(id, maxWired + 1); // park unwired nodes
    }

    // Columns left→right; nodes stacked within a column, centered on y=0.
    const GAP_X = 90;
    const GAP_Y = 50;
    const columns = new Map<number, ArrNode[]>();
    for (const node of nodes.values()) {
      const l = layer.get(node.id)!;
      if (!columns.has(l)) columns.set(l, []);
      columns.get(l)!.push(node);
    }
    let cx = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of [...columns.keys()].sort((a, b) => a - b)) {
      const col = columns.get(l)!;
      col.sort((a, b) => a.y0 - b.y0); // keep rough vertical order stable
      const totalH = col.reduce((s, n) => s + n.h, 0) + GAP_Y * (col.length - 1);
      let cy = -totalH / 2;
      const colW = Math.max(...col.map((n) => n.w));
      for (const node of col) {
        const nx = cx + (colW - node.w) / 2;
        if (node.mv) {
          // Model snaps to final; the tile glides there visually.
          this.queueTween(node.mv, nx, cy);
          node.mv.instance.x = nx;
          node.mv.instance.y = cy;
        } else if (node.gv) {
          const dx = nx - node.gv.group.x;
          const dy = cy - node.gv.group.y;
          this.queueTween(node.gv, nx, cy);
          node.gv.group.x = nx;
          node.gv.group.y = cy;
          // Members travel with the collapsed tile so expand stays nearby.
          for (const id of graph.modulesInGroup(node.gv.group.id)) {
            const m = graph.modules.get(id);
            if (m) {
              m.x += dx;
              m.y += dy;
            }
          }
        }
        minX = Math.min(minX, nx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, nx + node.w);
        maxY = Math.max(maxY, cy + node.h);
        cy += node.h + GAP_Y;
      }
      cx += colW + GAP_X;
    }

    // Re-center the view on the arranged patch (glides along with the tiles).
    const scale = this.world.scale.x;
    this.queueTween(
      this.world,
      this.app.screen.width / 2 - ((minX + maxX) / 2) * scale,
      this.app.screen.height / 2 - ((minY + maxY) / 2) * scale,
    );
  }

  // -- view lifecycle -------------------------------------------------------

  private rebuildAll(): void {
    for (const view of this.views.values()) view.destroy({ children: true });
    this.views.clear();
    this.syncViews();
  }

  /** Collapsed-state snapshot from the previous sync, for toggle animation. */
  private prevCollapsed = new Map<string, boolean>();

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
      frame.ai.destroy();
      frame.rename.destroy();
      frame.swatch.destroy();
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
        // Frame background: double-click to collapse the group (members render in
        // front, so clicks on a module still hit the module — only the empty
        // frame area reaches here).
        g.eventMode = 'static';
        let lastTap = 0;
        g.on('pointertap', () => {
          const now = performance.now();
          if (now - lastTap < 350) appState.toggleGroupCollapsed(group.id);
          lastTap = now;
        });
        const title = new Text({
          text: `▣ ${group.name}  ▾`,
          style: { fontSize: 12, fill: theme.textDim, fontWeight: 'bold' },
        });
        title.eventMode = 'static';
        title.cursor = 'grab';
        // Drag the title bar to move the whole group; a click (no drag) collapses.
        title.on('pointerdown', (e) => this.startFrameDrag(group, e));
        title.on('pointertap', () => appState.toggleGroupCollapsed(group.id));
        // AI edit + rename + recolor on the frame title row (PRD §6).
        const ai = new Text({ text: '🤖', style: { fontSize: 11, fill: theme.textDim } });
        ai.eventMode = 'static';
        ai.cursor = 'pointer';
        ai.on('pointertap', () =>
          window.dispatchEvent(new CustomEvent('kk-ai-group', { detail: { groupId: group.id } })),
        );
        const rename = new Text({ text: '✎', style: { fontSize: 11, fill: theme.textDim } });
        rename.eventMode = 'static';
        rename.cursor = 'pointer';
        rename.on('pointertap', () => {
          const name = window.prompt('Group name', group.name);
          if (name !== null) appState.renameGroup(group.id, name);
        });
        const swatch = new Graphics()
          .circle(0, 0, 5)
          .fill(group.color ?? theme.groupStroke)
          .stroke({ width: 1, color: 0x16161c });
        swatch.eventMode = 'static';
        swatch.cursor = 'pointer';
        swatch.on('pointertap', () => appState.recolorGroup(group.id, nextGroupColor(group.color)));
        this.frameLayer.addChild(g);
        this.frameLayer.addChild(title);
        this.frameLayer.addChild(ai);
        this.frameLayer.addChild(rename);
        this.frameLayer.addChild(swatch);
        this.frames.set(group.id, { group, g, title, ai, rename, swatch });
      }
    }

    // Visibility: modules hidden behind a collapsed group don't render.
    for (const [id, view] of this.views) {
      view.visible = !graph.hiddenBehind(id);
    }

    // Expand/shrink animation: pop in whatever a toggled group just revealed —
    // the collapsed tile when shrinking, the member tiles when expanding.
    // Works for every path (double-click, ⛶/▾ buttons, toolbar Shrink, undo).
    for (const group of graph.groups.values()) {
      const prev = this.prevCollapsed.get(group.id);
      if (prev === undefined || prev === group.collapsed) continue;
      if (graph.groupHiddenBehind(group.id)) continue;
      if (group.collapsed) {
        this.groupViews.get(group.id)?.popIn();
      } else {
        for (const id of graph.modulesInGroup(group.id)) {
          const v = this.views.get(id);
          if (v?.visible) v.popIn();
        }
        // Collapsed child groups inside the expanded frame render as tiles.
        for (const childId of group.groupIds) this.groupViews.get(childId)?.popIn();
      }
    }
    this.prevCollapsed.clear();
    for (const group of graph.groups.values()) this.prevCollapsed.set(group.id, group.collapsed);
  }

  /** A group's poles: stable baseline (crossing + unconnected) ± override. */
  private boundaryPorts(group: ModuleGroup): BoundaryPort[] {
    return appState.graph.groupPoles(group.id);
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

  // -- drag-to-delete trash zone ----------------------------------------------

  private buildTrash(): void {
    const { w, h } = this.trashRect;
    const g = new Graphics()
      .roundRect(0, 0, w, h, 12)
      .fill({ color: 0x3a1414, alpha: 0.92 })
      .stroke({ width: 1.5, color: 0xff5a5a, alpha: 0.8 });
    g.label = 'bg';
    const icon = new Text({
      text: '🗑  drop to delete',
      style: { fill: 0xff8a8a, fontSize: 14, fontWeight: '600' },
    });
    icon.anchor.set(0.5);
    icon.position.set(w / 2, h / 2);
    this.trash.addChild(g, icon);
    this.trash.visible = false;
    this.trash.eventMode = 'none';
    this.trash.pivot.set(w / 2, h / 2); // scale/grow from center on hover
    this.layoutTrash();
  }

  private layoutTrash(): void {
    const { w, h } = this.trashRect;
    const x = this.app.screen.width / 2;
    const y = this.app.screen.height - 28 - h / 2;
    this.trash.position.set(x, y);
    // Store screen-space bounds for hover hit-testing.
    this.trashRect.x = x - w / 2;
    this.trashRect.y = y - h / 2;
  }

  private showTrash(): void {
    this.overTrash = false;
    this.trash.visible = true;
    this.trash.scale.set(1);
    (this.trash.getChildByLabel('bg') as Graphics).alpha = 1;
  }

  private hideTrash(): void {
    this.trash.visible = false;
    this.overTrash = false;
  }

  private updateTrashHover(global: { x: number; y: number }): void {
    if (!this.trash.visible) return;
    const { x, y, w, h } = this.trashRect;
    const over = global.x >= x && global.x <= x + w && global.y >= y && global.y <= y + h;
    if (over === this.overTrash) return;
    this.overTrash = over;
    this.trash.scale.set(over ? 1.18 : 1);
    (this.trash.getChildByLabel('bg') as Graphics).alpha = over ? 1 : 0.85;
  }

  private startModuleDrag(view: ModuleView, e: FederatedPointerEvent): void {
    e.stopPropagation();
    view.cancelPop(); // grabbing a still-popping module settles it immediately
    appState.beginUndoable(); // whole drag = one undo step
    const p = this.world.toLocal(e.global);
    this.moduleDrag = { view, offsetX: p.x - view.position.x, offsetY: p.y - view.position.y };
    const touch = e.pointerType === 'touch' && isTouchMode();
    if (e.shiftKey) {
      appState.addToSelection({ moduleId: view.instance.id }, true);
    } else if (!appState.selectedModuleIds.has(view.instance.id)) {
      // Touch defers the replace to movement/release: a long-press must be
      // able to *add* to the selection instead (shift-click stand-in).
      if (touch) this.pendingSelect = view;
      else appState.select({ moduleId: view.instance.id });
    }
    if (touch) this.armLongPress(e, { kind: 'module', view });
    this.moduleLayer.setChildIndex(view, this.moduleLayer.children.length - 1);
    this.showTrash();
  }

  private startGroupDrag(view: GroupView, e: FederatedPointerEvent): void {
    e.stopPropagation();
    view.cancelPop();
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
    this.showTrash();
  }

  /** Drag the background of an expanded frame: the whole group travels. */
  private startFrameDrag(group: ModuleGroup, e: FederatedPointerEvent): void {
    e.stopPropagation();
    appState.beginUndoable();
    const p = this.world.toLocal(e.global);
    const moduleStart = new Map<string, { x: number; y: number }>();
    for (const id of appState.graph.modulesInGroup(group.id)) {
      const m = appState.graph.modules.get(id);
      if (m) moduleStart.set(id, { x: m.x, y: m.y });
    }
    // Nested collapsed descendants render as their own tile — move it directly.
    const groupStart = new Map<string, { x: number; y: number }>();
    const collectGroups = (gid: string) => {
      const grp = appState.graph.groups.get(gid);
      if (!grp) return;
      for (const child of grp.groupIds) {
        const cg = appState.graph.groups.get(child);
        if (cg) groupStart.set(child, { x: cg.x, y: cg.y });
        collectGroups(child);
      }
    };
    collectGroups(group.id);
    this.frameDrag = { group, start: p, dx: 0, dy: 0, moduleStart, groupStart };
    if (e.shiftKey) appState.addToSelection({ groupId: group.id }, true);
    else appState.select({ groupId: group.id });
    this.showTrash();
  }

  /** Keep modules from overlapping (PRD §5): push the dropped module out. */
  private resolveCollisions(view: ModuleView): void {
    const margin = 10;
    for (let iter = 0; iter < 8; iter++) {
      let pushed = false;
      for (const other of this.views.values()) {
        if (other === view || !other.visible) continue;
        const ax = view.position.x, ay = view.position.y, aw = view.w, ah = view.h;
        const bx = other.position.x, by = other.position.y, bw = other.w, bh = other.h;
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

  private lastWireTap = { id: '', at: 0 };

  private onStageDown(e: FederatedPointerEvent): void {
    if (this.pinch) return; // second finger of a pinch: ignore
    // Reaches here only when nothing interactive consumed it: empty canvas.
    const wire = this.hitTestWire(e);
    if (wire) {
      // Double-click deletes the wire (single click selects + arms drag-to-trash).
      const now = performance.now();
      if (this.lastWireTap.id === wire.id && now - this.lastWireTap.at < 350) {
        this.lastWireTap = { id: '', at: 0 };
        appState.disconnect(wire.id);
        return;
      }
      this.lastWireTap = { id: wire.id, at: now };
      // Grab the wire: select it and arm drag-to-trash (Q6 c2).
      appState.select({ wireId: wire.id });
      this.wireMoveDrag = { wire };
      this.showTrash();
      return;
    }
    if (e.shiftKey) {
      this.bandStart = this.world.toLocal(e.global);
      return;
    }
    if (e.pointerType === 'touch' && isTouchMode()) {
      // Double-tap empty canvas: zoom-to-fit (tap again for 100%).
      const now = performance.now();
      const { x, y } = e.global;
      const last = this.lastCanvasTap;
      this.lastCanvasTap = { at: now, x, y };
      if (now - last.at < 350 && Math.hypot(x - last.x, y - last.y) < 40) {
        this.lastCanvasTap = { at: 0, x: 0, y: 0 };
        this.fitView();
        return;
      }
      // Defer the deselect to pointerup — a second finger (pinch / undo tap)
      // or an edge swipe must not clear the selection.
      this.pendingDeselect = true;
      this.armLongPress(e, { kind: 'canvas' });
    } else {
      appState.select(null);
    }
    this.panning = {
      startX: e.global.x,
      startY: e.global.y,
      worldX: this.world.position.x,
      worldY: this.world.position.y,
    };
  }

  // -- touch long-press (multi-select without a shift key) --------------------

  private armLongPress(
    e: FederatedPointerEvent,
    target: { kind: 'module'; view: ModuleView } | { kind: 'canvas' },
  ): void {
    this.clearLongPress();
    this.longPress = {
      global: { x: e.global.x, y: e.global.y },
      target,
      timer: window.setTimeout(() => this.fireLongPress(), 450),
    };
  }

  private clearLongPress(): void {
    if (this.longPress) window.clearTimeout(this.longPress.timer);
    this.longPress = null;
  }

  private fireLongPress(): void {
    const lp = this.longPress;
    this.longPress = null;
    if (!lp) return;
    navigator.vibrate?.(15);
    if (lp.target.kind === 'module') {
      // Toggle into/out of the multi-selection; the hold can keep dragging —
      // the whole selection travels, exactly like a shift-click drag.
      this.pendingSelect = null;
      appState.addToSelection({ moduleId: lp.target.view.instance.id }, true);
    } else {
      // Empty canvas: the hold flips from panning to a rubber-band select.
      this.panning = null;
      this.pendingDeselect = false;
      this.bandStart = this.world.toLocal(lp.global);
    }
  }

  private onStageMove(e: FederatedPointerEvent): void {
    if (this.pinch) return; // pinch owns the gesture; skip pan/drag updates
    // Movement past the slop radius means a drag, not a hold: cancel the
    // long-press and resolve a deferred touch-select so the drag persists.
    if (
      this.longPress &&
      Math.hypot(e.global.x - this.longPress.global.x, e.global.y - this.longPress.global.y) > 10
    ) {
      this.clearLongPress();
      if (this.pendingSelect) {
        appState.select({ moduleId: this.pendingSelect.instance.id });
        this.pendingSelect = null;
      }
    }
    this.updateTrashHover(e.global);
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
    } else if (this.frameDrag) {
      const p = this.world.toLocal(e.global);
      const fd = this.frameDrag;
      fd.dx = p.x - fd.start.x;
      fd.dy = p.y - fd.start.y;
      for (const [id, s] of fd.moduleStart) {
        const v = this.views.get(id);
        if (v) v.position.set(s.x + fd.dx, s.y + fd.dy);
      }
      for (const [id, s] of fd.groupStart) {
        const gv = this.groupViews.get(id);
        if (gv) gv.position.set(s.x + fd.dx, s.y + fd.dy);
      }
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
    // Resolve deferred touch taps: a plain tap selects / deselects on release.
    this.clearLongPress();
    if (this.pendingSelect) {
      appState.select({ moduleId: this.pendingSelect.instance.id });
      this.pendingSelect = null;
    }
    if (this.pendingDeselect) {
      appState.select(null);
      this.pendingDeselect = false;
    }
    // Dropped over the trash zone: delete instead of place (Q7, undoable).
    const dropDelete = this.overTrash;
    this.hideTrash();

    if (this.wireMoveDrag) {
      const { wire } = this.wireMoveDrag;
      this.wireMoveDrag = null;
      if (dropDelete) appState.disconnect(wire.id);
    }
    if (this.wireDrag) {
      this.wireDrag = null;
      this.highlightCompatiblePorts(false);
    }
    if (this.moduleDrag) {
      if (dropDelete) {
        appState.deleteSelection();
      } else {
        this.resolveCollisions(this.moduleDrag.view);
        // Persist positions of every multi-dragged module.
        for (const id of appState.selectedModuleIds) {
          const v = this.views.get(id);
          if (v) {
            v.instance.x = v.position.x;
            v.instance.y = v.position.y;
          }
        }
      }
      this.moduleDrag = null;
    }
    if (this.groupDrag) {
      if (dropDelete) {
        appState.deleteSelection();
        this.groupDrag = null;
      } else {
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
    }
    if (this.frameDrag) {
      const fd = this.frameDrag;
      this.frameDrag = null;
      if (dropDelete) {
        appState.deleteSelection();
      } else {
        for (const [id, s] of fd.moduleStart) {
          const m = appState.graph.modules.get(id);
          if (m) { m.x = s.x + fd.dx; m.y = s.y + fd.dy; }
        }
        for (const [id, s] of fd.groupStart) {
          const grp = appState.graph.groups.get(id);
          if (grp) { grp.x = s.x + fd.dx; grp.y = s.y + fd.dy; }
        }
      }
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
            vx + view.w > band.x && vx < band.x + band.width &&
            vy + view.h > band.y && vy < band.y + band.height
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

  // -- touch pinch-zoom -------------------------------------------------------

  /** Distance + midpoint of the first two touches, in canvas-local coords. */
  private touchMetrics(e: TouchEvent): { dist: number; mid: { x: number; y: number } } {
    const rect = this.app.canvas.getBoundingClientRect();
    const a = e.touches[0];
    const b = e.touches[1];
    const ax = a.clientX - rect.left, ay = a.clientY - rect.top;
    const bx = b.clientX - rect.left, by = b.clientY - rect.top;
    return {
      dist: Math.hypot(bx - ax, by - ay),
      mid: { x: (ax + bx) / 2, y: (ay + by) / 2 },
    };
  }

  private onTouchStart(e: TouchEvent): void {
    if (isTouchMode() && e.touches.length === 1) {
      // Arm an edge swipe-in: left edge opens the palette, right the library.
      const rect = this.app.canvas.getBoundingClientRect();
      const x = e.touches[0].clientX;
      if (x - rect.left < 24) this.edgeSwipe = { side: 'left', startX: x };
      else if (rect.right - x < 24) this.edgeSwipe = { side: 'right', startX: x };
      else this.edgeSwipe = null;
    }
    if (e.touches.length < 2) return;
    this.edgeSwipe = null;
    // Never hijack an in-flight object grab (no mobile undo to recover from).
    if (this.moduleDrag || this.groupDrag || this.wireDrag || this.wireMoveDrag) return;
    // Two/three-finger tap = undo/redo, decided on release if nothing moved.
    this.multiTap = {
      count: Math.max(e.touches.length, this.multiTap?.count ?? 0),
      at: this.multiTap?.at ?? performance.now(),
      moved: this.multiTap?.moved ?? false,
    };
    e.preventDefault();
    this.panning = null; // drop any one-finger pan; pinch takes over
    this.bandStart = null;
    this.pendingDeselect = false; // a second finger means gesture, not tap
    this.pendingSelect = null;
    this.clearLongPress();
    this.pinch = this.touchMetrics(e);
    this.pinchStart = this.pinch;
  }

  private onTouchMove(e: TouchEvent): void {
    // Edge swipe: enough inward travel opens the panel and swallows the pan.
    if (this.edgeSwipe && e.touches.length === 1 && isTouchMode()) {
      const dx = e.touches[0].clientX - this.edgeSwipe.startX;
      const { side } = this.edgeSwipe;
      if ((side === 'left' && dx > 48) || (side === 'right' && dx < -48)) {
        this.edgeSwipe = null;
        this.clearLongPress();
        this.pendingDeselect = false;
        if (this.panning) {
          // Roll back the few pixels of pan the swipe dragged in.
          this.world.position.set(this.panning.worldX, this.panning.worldY);
          this.panning = null;
        }
        window.dispatchEvent(
          new CustomEvent(side === 'left' ? 'kk-open-palette' : 'kk-open-library'),
        );
        return;
      }
    }
    if (!this.pinch || e.touches.length < 2) return;
    e.preventDefault();
    const { dist, mid } = this.touchMetrics(e);
    // Fingers travelling past the slop means a real pinch, not a tap.
    if (this.pinchStart && this.multiTap && !this.multiTap.moved) {
      if (
        Math.abs(dist - this.pinchStart.dist) > 12 ||
        Math.hypot(mid.x - this.pinchStart.mid.x, mid.y - this.pinchStart.mid.y) > 12
      ) {
        this.multiTap.moved = true;
      }
    }
    const prev = this.pinch;
    // Zoom: scale by the distance ratio, clamped to the wheel-zoom range,
    // anchored at the current midpoint (world point under the mid stays put).
    const factor = prev.dist > 0 ? dist / prev.dist : 1;
    const next = Math.min(2.5, Math.max(0.2, this.world.scale.x * factor));
    const wx = (prev.mid.x - this.world.position.x) / this.world.scale.x;
    const wy = (prev.mid.y - this.world.position.y) / this.world.scale.y;
    this.world.scale.set(next);
    this.world.position.set(prev.mid.x - wx * next, prev.mid.y - wy * next);
    // Pan: translate by how far the midpoint travelled between frames.
    this.world.position.set(
      this.world.position.x + (mid.x - prev.mid.x),
      this.world.position.y + (mid.y - prev.mid.y),
    );
    this.pinch = { dist, mid };
  }

  private onTouchEnd(e: TouchEvent): void {
    if (e.touches.length < 2) {
      this.pinch = null;
      this.pinchStart = null;
    }
    if (e.touches.length === 0) {
      this.edgeSwipe = null;
      const tap = this.multiTap;
      this.multiTap = null;
      // Quick multi-finger tap that never travelled: undo (2) / redo (3).
      if (tap && !tap.moved && performance.now() - tap.at < 350) {
        navigator.vibrate?.(10);
        if (tap.count === 2) appState.undo();
        else if (tap.count >= 3) appState.redo();
      }
    }
  }

  /** System interrupted the gesture (notification shade, app switch): reset. */
  private onTouchCancel(): void {
    this.pinch = null;
    this.pinchStart = null;
    this.multiTap = null;
    this.edgeSwipe = null;
    this.pendingSelect = null;
    this.pendingDeselect = false;
    this.clearLongPress();
  }

  /** Fit the whole patch in view; if already fitted, return to 100%. */
  fitView(): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const include = (x: number, y: number, w: number, h: number) => {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    };
    for (const v of this.views.values()) {
      if (v.visible) include(v.position.x, v.position.y, v.w, v.h);
    }
    for (const gv of this.groupViews.values()) {
      include(gv.position.x, gv.position.y, gv.tileWidth, gv.tileHeight);
    }
    if (!Number.isFinite(minX)) return;
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    const pad = 60;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let scale = Math.min(2.5, Math.max(0.2, Math.min((sw - pad) / w, (sh - pad) / h)));
    let px = sw / 2 - cx * scale;
    let py = sh / 2 - cy * scale;
    if (
      Math.abs(this.world.scale.x - scale) < 0.01 &&
      Math.hypot(this.world.position.x - px, this.world.position.y - py) < 2
    ) {
      scale = 1; // already fitted → toggle back to 100%
      px = sw / 2 - cx;
      py = sh / 2 - cy;
    }
    this.world.scale.set(scale);
    this.world.position.set(px, py);
  }

  // -- wire rendering --------------------------------------------------------

  /** Resolve a wire endpoint to a visible anchor: module port or group proxy. */
  private endpointPosition(ref: PortRef): { x: number; y: number } | null {
    // Group endpoint (intrinsic pole, e.g. tint): the collapsed tile's pole
    // dot, the hiding ancestor's tile, or the expanded frame's title corner.
    if (appState.graph.groups.has(ref.moduleId)) {
      const behind = appState.graph.groupHiddenBehind(ref.moduleId);
      const gv = this.groupViews.get(behind?.id ?? ref.moduleId);
      if (gv) {
        return (
          gv.portWorldPosition(`${ref.moduleId}:${ref.portId}`) ?? {
            x: gv.position.x + gv.tileWidth / 2,
            y: gv.position.y + gv.tileHeight / 2,
          }
        );
      }
      return this.frameAnchors.get(ref.moduleId) ?? null;
    }
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
    const threshold = (isTouchMode() ? 14 : 8) / this.world.scale.x;
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
    for (const { group, g, title, ai, rename, swatch } of this.frames.values()) {
      // Bounding box over visible member views (modules + nested group tiles).
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const include = (x: number, y: number, w: number, h: number) => {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
      };
      for (const id of group.moduleIds) {
        const v = this.views.get(id);
        if (v && v.visible) include(v.position.x, v.position.y, v.w, v.h);
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
      ai.position.set(title.position.x + title.width + 10, title.position.y + 1);
      rename.position.set(ai.position.x + 20, title.position.y + 1);
      swatch.position.set(rename.position.x + 18, title.position.y + 8);
      // Wire-endpoint anchor for the group's intrinsic poles while expanded.
      this.frameAnchors.set(group.id, { x: minX - pad, y: minY - pad - 8 });
    }
  }

  private tick(): void {
    const now = performance.now();
    this.advanceTweens(now);
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

    // Resolve tints: nearest wired source (own tint port, then enclosing
    // groups inside-out) colors each view's accents. Group tiles resolve
    // their own tint in GroupView.updateLive.
    appState.tickTints(now - this.lastTickAt);
    this.lastTickAt = now;
    for (const [id, view] of this.views) {
      view.setLiveColor(appState.tintFor(id));
    }
    // Tint sources hidden inside collapsed groups still render (throttled),
    // so the derived color keeps moving.
    for (const id of appState.tintSourceIds()) {
      const v = this.views.get(id);
      if (!v || !v.visible) tickHiddenTintSource(id);
    }

    for (const view of this.views.values()) {
      if (!view.visible) continue;
      view.advancePop(now);
      view.updateLive();
    }
    for (const gv of this.groupViews.values()) {
      gv.advancePop(now);
      gv.updateLive();
    }
  }

  private strokePath(points: Array<{ x: number; y: number }>, width: number, color: number, alpha: number): void {
    this.wireLayer.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) this.wireLayer.lineTo(points[i].x, points[i].y);
    this.wireLayer.stroke({ width, color, alpha, cap: 'round', join: 'round' });
  }
}

export const patchCanvas = new PatchCanvas();
