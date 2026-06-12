/**
 * Module group visuals (PRD §6): a collapsed group renders as a single tile
 * whose ports proxy the member ports that have wires crossing the group
 * boundary; an expanded group renders as a frame behind its members with a
 * title bar and a collapse button.
 */

import { Container, FederatedPointerEvent, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { FaceElement } from '../core/face';
import type { ModuleGroup } from '../core/graph';
import type { ParamSpec } from '../core/module';
import { PORT_TYPE_COLORS, type PortType } from '../core/types';
import { appState } from '../state';
import { nextGroupColor, theme } from '../theme';
import { MODULE_TITLE_H, ModuleView, PORT_RADIUS, type PortHandlers } from './ModuleView';
import { RESIZE_DIRS, inResizeBand, resizeCursor, resizeSize, type ResizeDir } from './resize';
import type { Tooltip } from './Tooltip';

const TITLE_H = 24;

/** Headless embeds never wire ports — their port layer isn't built. */
const NOOP_PORT_HANDLERS: PortHandlers = {
  onPortDown: () => {},
  onPortUp: () => {},
  onBodyDown: () => {},
};

const NOOP_GROUP_HANDLERS: GroupHandlers = {
  onPortDown: () => {},
  onPortUp: () => {},
  onBodyDown: () => {},
  onToggleCollapse: () => {},
};

/** Data-URL → Texture cache for face backgrounds/images. */
const faceTextures = new Map<string, Texture | 'loading'>();

function faceTexture(assetId: string, onReady: () => void): Texture | null {
  const cached = faceTextures.get(assetId);
  if (cached instanceof Texture) return cached;
  if (cached === 'loading') return null;
  const url = appState.faceAssets.get(assetId);
  if (!url) return null;
  faceTextures.set(assetId, 'loading');
  const img = new Image();
  img.onload = () => {
    faceTextures.set(assetId, Texture.from(img));
    onReady();
  };
  img.src = url;
  return null;
}

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
  /** Persistent resize hit-zones — survive in-place re-renders during a drag. */
  private resizeHandles: Graphics[] = [];
  private popUntil = 0;
  private popFrom = { x: 0, y: 0 };
  private static readonly POP_MS = 340;

  constructor(
    readonly group: ModuleGroup,
    private boundaryPorts: BoundaryPort[],
    private handlers: GroupHandlers,
    private tooltip: Tooltip,
    /** Headless: face-view sub-panel embed — faced tile only (no title
     * buttons, ports, resize, body drag); double-click runs onOpen. */
    private opts: { headless?: boolean; onOpen?: () => void } = {},
  ) {
    super();
    // Headless embeds always render the faced tile, whatever the child's
    // collapsed state on the (hidden) canvas.
    if (group.collapsed || opts.headless) this.buildCollapsedTile();
    // Expanded frame is drawn by the canvas each tick (it must track member
    // positions); this view only renders the collapsed tile.
  }

  private buildCollapsedTile(): void {
    // In-place re-render (live resize) reuses this: drop the old tile but keep
    // the persistent resize handles so the captured node is never destroyed.
    const kids = [...this.children];
    this.removeChildren();
    for (const k of kids) {
      if (this.resizeHandles.includes(k as Graphics)) continue;
      k.destroy({ children: true });
    }
    this.portCenters.clear();
    this.portDots.clear();
    this.liveDraws = [];
    this.embedded = []; // instances are destroyed with the tile's children

    const face = this.group.face;
    const inputs = this.boundaryPorts.filter((p) => p.direction === 'in');
    const outputs = this.boundaryPorts.filter((p) => p.direction === 'out');
    const rows = Math.max(inputs.length, outputs.length, 1);
    if (face) {
      this.tileWidth = face.width;
      this.tileHeight = TITLE_H + face.height;
    } else {
      this.tileWidth = this.group.w ?? 170;
      this.tileHeight = this.group.h ?? TITLE_H + 18 + rows * 26;
    }
    const w = this.tileWidth;
    const h = this.tileHeight;
    this.position.set(this.group.x, this.group.y);

    const body = new Graphics()
      .roundRect(0, 0, w, h, 10)
      .fill(face?.bgColor ?? theme.groupBody)
      .stroke({ width: 2, color: this.group.color ?? theme.groupStroke });
    body.roundRect(0, 0, w, TITLE_H, 10).fill(theme.groupTitle);
    body.rect(0, TITLE_H - 8, w, 8).fill(theme.groupTitle);
    body.eventMode = 'static';
    if (this.opts.headless) {
      // Sub-panel embed: swallow drags (the host tile must not move from
      // inside the panel); double-tap drills into the child group.
      body.cursor = this.opts.onOpen ? 'pointer' : 'default';
      let lastTap = 0;
      body.on('pointertap', () => {
        const now = performance.now();
        if (now - lastTap < 350) {
          lastTap = 0;
          this.opts.onOpen?.();
        } else {
          lastTap = now;
        }
      });
      body.on('pointerover', (e) =>
        this.tooltip.show(
          [this.group.name, this.opts.onOpen ? 'Sub-panel — double-click to open the group.' : 'Sub-panel.'],
          e.clientX,
          e.clientY,
        ),
      );
      body.on('pointerout', () => this.tooltip.hide());
    } else {
      body.cursor = 'grab';
      body.on('pointerdown', (e) => this.handlers.onBodyDown(this, e));
      // Double-click (tile anywhere; faced tiles: title bar only) expands — PRD §6.
      let lastTap = 0;
      body.on('pointertap', (e) => {
        if (face && this.toLocal(e.global).y > TITLE_H) return;
        const now = performance.now();
        if (now - lastTap < 350) this.handlers.onToggleCollapse(this.group.id);
        lastTap = now;
      });
      body.on('pointerover', (e) =>
        this.tooltip.show(
          [this.group.name, `Module group — ${appState.graph.modulesInGroup(this.group.id).size} modules. Double-click ${face ? 'the title bar' : ''} to open.`],
          e.clientX,
          e.clientY,
        ),
      );
      body.on('pointerout', () => this.tooltip.hide());
    }
    this.addChild(body);

    // Background image, stretched to the face area.
    if (face?.bgAssetId) {
      const apply = () => {
        const tex = faceTextures.get(face.bgAssetId!);
        if (!(tex instanceof Texture) || this.destroyed) return;
        const sprite = new Sprite(tex);
        sprite.position.set(1, TITLE_H);
        sprite.width = w - 2;
        sprite.height = h - TITLE_H - 1;
        sprite.eventMode = 'none';
        this.addChildAt(sprite, this.getChildIndex(body) + 1);
      };
      if (faceTexture(face.bgAssetId, apply)) apply();
    }

    if (!this.opts.headless) this.buildTileChrome(w);

    if (face) {
      for (const el of face.elements) this.buildFaceElement(el);
    }
    if (this.opts.headless) return; // no ports/resize on embeds

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

    this.mountResizeHandles();
  }

  /** Title text + title-bar buttons + color swatch (full tiles only). */
  private buildTileChrome(w: number): void {
    const title = new Text({
      text: `▣ ${this.group.name}`,
      style: { fontSize: 12, fill: theme.text, fontWeight: 'bold' },
    });
    title.position.set(8, 5);
    title.eventMode = 'none';
    this.addChild(title);

    // Title-bar buttons: expand (⛶), edit face (🎛), rename (✎), recolor (⬤).
    const titleButton = (
      glyph: string,
      x: number,
      tip: string[],
      onTap: () => void,
    ): void => {
      const t = new Text({ text: glyph, style: { fontSize: 11, fill: theme.textDim } });
      t.anchor.set(1, 0);
      t.position.set(x, 6);
      t.eventMode = 'none';
      this.addChild(t);
      // Glyph bounds are font-dependent — a fixed hit rect keeps it clickable.
      const hit = new Graphics().rect(x - 14, 2, 18, 20).fill({ color: 0xffffff, alpha: 0.001 });
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.on('pointerdown', (e) => {
        e.stopPropagation();
        onTap();
      });
      hit.on('pointerover', (e) => this.tooltip.show(tip, e.clientX, e.clientY));
      hit.on('pointerout', () => this.tooltip.hide());
      this.addChild(hit);
    };

    titleButton('⛶', w - 66, ['Expand', 'Open the group: all modules inside, wired up.'], () =>
      this.handlers.onToggleCollapse(this.group.id),
    );
    titleButton('🎛', w - 48, ['Edit face', 'Design this module’s control panel.'], () =>
      appState.openFaceEditor(this.group.id),
    );
    titleButton('✎', w - 24, ['Rename group'], () => {
      const name = window.prompt('Group name', this.group.name);
      if (name !== null) appState.renameGroup(this.group.id, name);
    });

    const swatch = new Graphics()
      .circle(0, 0, 5)
      .fill(this.group.color ?? theme.groupStroke)
      .stroke({ width: 1, color: 0x16161c });
    swatch.position.set(w - 10, 12);
    swatch.eventMode = 'static';
    swatch.cursor = 'pointer';
    swatch.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.recolorGroup(this.group.id, nextGroupColor(this.group.color));
    });
    swatch.on('pointerover', (e) => this.tooltip.show(['Recolor group', 'Click to cycle colors.'], e.clientX, e.clientY));
    swatch.on('pointerout', () => this.tooltip.hide());
    this.addChild(swatch);
  }

  // -- resize (all sides) ----------------------------------------------------

  /** Eight persistent hit-zones; re-rendered in place during a drag (faced
   * tiles write face.width/height, plain tiles write group.w/h). */
  private mountResizeHandles(): void {
    if (this.resizeHandles.length === 0) {
      for (const dir of RESIZE_DIRS) {
        const g = new Graphics();
        g.eventMode = 'static';
        g.cursor = resizeCursor(dir);
        g.hitArea = {
          contains: (px, py) =>
            inResizeBand(dir, px, py, this.tileWidth, this.tileHeight) && !this.overPole(px, py),
        };
        g.on('pointerdown', (e) => {
          e.stopPropagation();
          this.beginResize(dir, e);
        });
        g.on('pointerover', (ev) =>
          this.tooltip.show(['Resize', 'Drag any edge or corner.'], ev.clientX, ev.clientY),
        );
        g.on('pointerout', () => this.tooltip.hide());
        this.resizeHandles.push(g);
      }
    }
    for (const g of this.resizeHandles) this.addChild(g);
  }

  /** True if a tile-local point sits on a pole dot — resize yields to the pole
   * there so edge poles stay grabbable (wire + hover tooltip), not resized. */
  private overPole(px: number, py: number): boolean {
    for (const c of this.portCenters.values()) {
      const dx = px - c.x;
      const dy = py - c.y;
      if (dx * dx + dy * dy < 20 * 20) return true;
    }
    return false;
  }

  private beginResize(dir: ResizeDir, e: FederatedPointerEvent): void {
    appState.beginUndoable();
    const face = this.group.face;
    const startW = this.tileWidth;
    const startH = this.tileHeight;
    const startX = this.group.x;
    const startY = this.group.y;
    const sx = e.clientX;
    const sy = e.clientY;
    const scale = this.worldTransform.a || 1;
    let raf = 0;
    // Groups are containers — minimum only, stretch to any size.
    const MIN_W = 120, MIN_H = 80;
    const apply = (ev: PointerEvent) => {
      const { w, h } = resizeSize(dir, (ev.clientX - sx) / scale, (ev.clientY - sy) / scale, startW, startH);
      const cw = Math.max(MIN_W, w);
      // Faced tile height = TITLE_H + face.height; clamp the face area itself.
      const ch = Math.max(MIN_H + (face ? TITLE_H : 0), h);
      if (face) {
        face.width = cw;
        face.height = ch - TITLE_H;
      } else {
        this.group.w = cw;
        this.group.h = ch;
      }
      // Anchor opposite edge for n/w using the clamped size.
      if (dir.includes('w')) this.group.x = startX + startW - cw;
      if (dir.includes('n')) this.group.y = startY + startH - ch;
    };
    const onMove = (ev: PointerEvent) => {
      apply(ev);
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          this.buildCollapsedTile(); // in-place re-render; handles persist
          this.position.set(this.group.x, this.group.y);
        });
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (raf) cancelAnimationFrame(raf);
      // Final snap to the committed size (mutations already persisted on group;
      // beginUndoable at drag start captured the one undo step).
      this.buildCollapsedTile();
      this.position.set(this.group.x, this.group.y);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // -- face elements (core/face.ts) -----------------------------------------

  /** Live-updating element redraws, run from the canvas ticker. */
  private liveDraws: Array<{ key: () => string; redraw: () => void; last: string }> = [];

  /** Headless tile embeds ('view' elements: member modules or child-group
   * sub-panels) + their tile-local rects. */
  private embedded: Array<{
    view: ModuleView | GroupView;
    /** Tile-local rect + extra scale of the embedded tile (for overlay anchoring). */
    rect: { x: number; y: number; scale: number };
  }> = [];

  private boundParam(
    moduleId?: string,
    paramId?: string,
  ): { value: number; spec: ParamSpec; moduleId: string; paramId: string } | null {
    if (!moduleId || !paramId) return null;
    const mod = appState.graph.modules.get(moduleId);
    if (!mod) return null;
    const spec = appState.graph.def(mod.type).params.find((p) => p.id === paramId);
    if (!spec) return null;
    return { value: mod.params[paramId] ?? spec.default, spec, moduleId, paramId };
  }

  private norm(moduleId?: string, paramId?: string): number {
    const b = this.boundParam(moduleId, paramId);
    if (!b) return 0;
    return (b.value - b.spec.min) / (b.spec.max - b.spec.min || 1);
  }

  private setNorm(moduleId: string, spec: ParamSpec, paramId: string, norm: number): void {
    const clamped = Math.min(1, Math.max(0, norm));
    let v = spec.min + clamped * (spec.max - spec.min);
    if (spec.options) v = Math.round(v);
    appState.setParam(moduleId, paramId, v);
  }

  /** Relative pointer drag in face-local px; one undo step per gesture. */
  private beginFaceDrag(e: FederatedPointerEvent, apply: (dx: number, dy: number) => void): void {
    appState.beginUndoable();
    const startX = e.clientX;
    const startY = e.clientY;
    const scale = this.worldTransform.a || 1;
    const onMove = (ev: PointerEvent) => apply((ev.clientX - startX) / scale, (ev.clientY - startY) / scale);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private elementTip(el: FaceElement, lines: string[]): string[] {
    const b = this.boundParam(el.moduleId, el.paramId);
    if (!b && el.kind !== 'label' && el.kind !== 'image') {
      return [el.label ?? el.kind, 'Unbound — open the face editor (🎛) to bind it.'];
    }
    return lines;
  }

  /** Caption text anchored top-center at (x + w/2, y). */
  private addCaption(parent: Container, el: FaceElement, fx: number, y: number): void {
    if (!el.label) return;
    const t = new Text({ text: el.label, style: { fontSize: 10, fill: theme.textDim } });
    t.anchor.set(0.5, 0);
    t.position.set(fx + el.w / 2, y);
    t.eventMode = 'none';
    parent.addChild(t);
  }

  private buildFaceElement(el: FaceElement): void {
    // Each element lives in its own container rotated about its center, so
    // rotation set in the face editor applies to drawing AND hit-testing.
    const wrap = new Container();
    wrap.position.set(el.x + el.w / 2, TITLE_H + el.y + el.h / 2);
    wrap.rotation = ((el.rot ?? 0) * Math.PI) / 180;
    this.addChild(wrap);
    const fx = -el.w / 2;
    const fy = -el.h / 2;
    // Screen-space drag delta → element-local delta (undo the rotation).
    const rotRad = ((el.rot ?? 0) * Math.PI) / 180;
    const localDelta = (dx: number, dy: number) => ({
      x: dx * Math.cos(rotRad) + dy * Math.sin(rotRad),
      y: -dx * Math.sin(rotRad) + dy * Math.cos(rotRad),
    });

    if (el.kind === 'view') {
      this.buildViewElement(el, wrap, fx, fy);
      return;
    }

    if (el.kind === 'label') {
      const t = new Text({
        text: el.text ?? '',
        style: { fontSize: el.size ?? 13, fill: el.color ?? theme.text },
      });
      t.position.set(fx, fy);
      t.eventMode = 'none';
      wrap.addChild(t);
      return;
    }

    if (el.kind === 'image') {
      if (!el.assetId) return;
      const apply = () => {
        const tex = faceTextures.get(el.assetId!);
        if (!(tex instanceof Texture) || this.destroyed) return;
        const sprite = new Sprite(tex);
        sprite.position.set(fx, fy);
        sprite.width = el.w;
        sprite.height = el.h;
        sprite.eventMode = 'none';
        wrap.addChild(sprite);
      };
      if (faceTexture(el.assetId, apply)) apply();
      return;
    }

    const g = new Graphics();
    wrap.addChild(g);

    if (el.kind === 'meter') {
      const redraw = () => {
        const peak = el.moduleId ? appState.meters[el.moduleId]?.peak ?? 0 : 0;
        g.clear();
        g.roundRect(fx, fy, el.w, el.h, 3).fill(theme.inset);
        const k = Math.min(1, peak);
        if (k > 0.001) {
          g.roundRect(fx + 1, fy + 1, (el.w - 2) * k, el.h - 2, 2)
            .fill(k > 0.9 ? 0xff5050 : 0x52e07a);
        }
      };
      redraw();
      this.liveDraws.push({
        key: () => String(el.moduleId ? appState.meters[el.moduleId]?.peak ?? 0 : 0),
        redraw,
        last: '',
      });
      this.addCaption(wrap, el, fx, fy + el.h + 2);
      return;
    }

    if (el.kind === 'readout') {
      g.roundRect(fx, fy, el.w, el.h, 3).fill(theme.inset);
      const t = new Text({ text: '—', style: { fontSize: 11, fill: theme.text } });
      t.anchor.set(0.5);
      t.position.set(fx + el.w / 2, fy + el.h / 2);
      t.eventMode = 'none';
      wrap.addChild(t);
      const redraw = () => {
        const b = this.boundParam(el.moduleId, el.paramId);
        if (!b) {
          t.text = '—';
          return;
        }
        t.text = b.spec.options
          ? b.spec.options[Math.round(b.value)] ?? String(b.value)
          : `${Math.abs(b.value) >= 100 ? b.value.toFixed(0) : b.value.toFixed(2)}${b.spec.unit ? ` ${b.spec.unit}` : ''}`;
      };
      redraw();
      this.liveDraws.push({
        key: () => String(this.boundParam(el.moduleId, el.paramId)?.value ?? NaN),
        redraw,
        last: '',
      });
      this.addCaption(wrap, el, fx, fy + el.h + 2);
      return;
    }

    // Interactive controls: knob / slider / xy / button.
    const bound = () => this.boundParam(el.moduleId, el.paramId);
    const dim = bound() ? 1 : 0.35;
    // Accent: a bound visual source's frame color, else the group's resolved tint.
    const accent = () => {
      const c = el.tintSourceId ? appState.tintValues[el.tintSourceId] : undefined;
      return c ?? this.resolvedTint();
    };

    if (el.kind === 'knob') {
      const cx = fx + el.w / 2;
      const r = Math.max(8, Math.min(el.w, el.h - (el.label ? 16 : 0)) / 2 - 6);
      const cy = fy + r + 6;
      const redraw = () => {
        const v = Math.min(1, Math.max(0, this.norm(el.moduleId, el.paramId)));
        const a0 = Math.PI * 0.75;
        const a1 = Math.PI * 2.25;
        const av = a0 + (a1 - a0) * v;
        g.clear();
        g.alpha = dim;
        g.circle(cx, cy, r * 0.78).fill(theme.inset).stroke({ width: 1, color: theme.moduleStroke });
        // moveTo before each arc: without it the path connects from its
        // current point (the graphics origin), drawing stray wire-like lines.
        g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
        g.arc(cx, cy, r, a0, a1).stroke({ width: 3, color: theme.inset });
        g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
        g.arc(cx, cy, r, a0, av).stroke({ width: 3, color: accent() });
        g.moveTo(cx + Math.cos(av) * r * 0.3, cy + Math.sin(av) * r * 0.3)
          .lineTo(cx + Math.cos(av) * r * 0.72, cy + Math.sin(av) * r * 0.72)
          .stroke({ width: 2, color: accent() });
      };
      redraw();
      this.liveDraws.push({ key: () => `${bound()?.value ?? NaN}:${accent()}`, redraw, last: '' });

      const hit = new Graphics().circle(cx, cy, r + 6).fill({ color: 0xffffff, alpha: 0.001 });
      hit.eventMode = 'static';
      hit.cursor = 'ns-resize';
      hit.on('pointerdown', (e) => {
        e.stopPropagation();
        const b = bound();
        if (!b) return;
        const start = this.norm(el.moduleId, el.paramId);
        this.beginFaceDrag(e, (_dx, dy) => {
          this.setNorm(b.moduleId, b.spec, b.paramId, start - dy / 120);
          redraw();
        });
      });
      hit.on('pointerover', (e) =>
        this.tooltip.show(this.elementTip(el, [el.label ?? 'Knob', 'Drag up/down.']), e.clientX, e.clientY),
      );
      hit.on('pointerout', () => this.tooltip.hide());
      wrap.addChild(hit);
      this.addCaption(wrap, el, fx, fy + el.h - 12);
      return;
    }

    if (el.kind === 'slider') {
      const horiz = el.w > el.h;
      const redraw = () => {
        const v = Math.min(1, Math.max(0, this.norm(el.moduleId, el.paramId)));
        g.clear();
        g.alpha = dim;
        if (horiz) {
          g.roundRect(fx, fy + el.h / 2 - 5, el.w, 10, 4).fill(theme.inset);
          g.roundRect(fx, fy + el.h / 2 - 5, el.w * v, 10, 4).fill(accent());
          g.roundRect(fx + el.w * v - 5, fy + el.h / 2 - 11, 10, 22, 3)
            .fill(theme.button).stroke({ width: 1, color: theme.text });
        } else {
          g.roundRect(fx + el.w / 2 - 5, fy, 10, el.h, 4).fill(theme.inset);
          g.roundRect(fx + el.w / 2 - 5, fy + el.h * (1 - v), 10, el.h * v, 4).fill(accent());
          g.roundRect(fx + el.w / 2 - 11, fy + el.h * (1 - v) - 5, 22, 10, 3)
            .fill(theme.button).stroke({ width: 1, color: theme.text });
        }
      };
      redraw();
      this.liveDraws.push({ key: () => `${bound()?.value ?? NaN}:${accent()}`, redraw, last: '' });

      const hit = new Graphics().rect(fx - 4, fy - 4, el.w + 8, el.h + 8).fill({ color: 0xffffff, alpha: 0.001 });
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.on('pointerdown', (e) => {
        e.stopPropagation();
        const b = bound();
        if (!b) return;
        appState.beginUndoable();
        const local = wrap.toLocal(e.global);
        this.setNorm(b.moduleId, b.spec, b.paramId, horiz ? (local.x - fx) / el.w : 1 - (local.y - fy) / el.h);
        redraw();
        const start = this.norm(el.moduleId, el.paramId);
        const scale = this.worldTransform.a || 1;
        const sx = e.clientX;
        const sy = e.clientY;
        const onMove = (ev: PointerEvent) => {
          const ld = localDelta((ev.clientX - sx) / scale, (ev.clientY - sy) / scale);
          const d = horiz ? ld.x / el.w : -ld.y / el.h;
          this.setNorm(b.moduleId, b.spec, b.paramId, start + d);
          redraw();
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
      hit.on('pointerover', (e) =>
        this.tooltip.show(this.elementTip(el, [el.label ?? 'Slider', 'Click or drag.']), e.clientX, e.clientY),
      );
      hit.on('pointerout', () => this.tooltip.hide());
      wrap.addChild(hit);
      this.addCaption(wrap, el, fx, fy + el.h + 2);
      return;
    }

    if (el.kind === 'xy') {
      const boundY = () => this.boundParam(el.moduleId2, el.paramId2);
      const padH = el.h - (el.label ? 16 : 0);
      const redraw = () => {
        const vx = Math.min(1, Math.max(0, this.norm(el.moduleId, el.paramId)));
        const vy = Math.min(1, Math.max(0, this.norm(el.moduleId2, el.paramId2)));
        g.clear();
        g.alpha = bound() || boundY() ? 1 : 0.35;
        g.roundRect(fx, fy, el.w, padH, 5).fill(theme.inset).stroke({ width: 1, color: theme.moduleStroke });
        const px = fx + vx * el.w;
        const py = fy + (1 - vy) * padH;
        g.moveTo(px, fy).lineTo(px, fy + padH).stroke({ width: 1, color: theme.textDim, alpha: 0.4 });
        g.moveTo(fx, py).lineTo(fx + el.w, py).stroke({ width: 1, color: theme.textDim, alpha: 0.4 });
        g.circle(px, py, 7).fill(accent()).stroke({ width: 2, color: theme.text });
      };
      redraw();
      this.liveDraws.push({
        key: () => `${bound()?.value ?? NaN}/${boundY()?.value ?? NaN}:${accent()}`,
        redraw,
        last: '',
      });

      const hit = new Graphics().rect(fx, fy, el.w, padH).fill({ color: 0xffffff, alpha: 0.001 });
      hit.eventMode = 'static';
      hit.cursor = 'crosshair';
      hit.on('pointerdown', (e) => {
        e.stopPropagation();
        const bx = bound();
        const by = boundY();
        if (!bx && !by) return;
        appState.beginUndoable();
        const apply = (localX: number, localY: number) => {
          if (bx) this.setNorm(bx.moduleId, bx.spec, bx.paramId, (localX - fx) / el.w);
          if (by) this.setNorm(by.moduleId, by.spec, by.paramId, 1 - (localY - fy) / padH);
          redraw();
        };
        const first = wrap.toLocal(e.global);
        apply(first.x, first.y);
        const scale = this.worldTransform.a || 1;
        const sx = e.clientX;
        const sy = e.clientY;
        const onMove = (ev: PointerEvent) => {
          const ld = localDelta((ev.clientX - sx) / scale, (ev.clientY - sy) / scale);
          apply(first.x + ld.x, first.y + ld.y);
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
      hit.on('pointerover', (e) =>
        this.tooltip.show(this.elementTip(el, [el.label ?? 'XY pad', 'Drag the puck.']), e.clientX, e.clientY),
      );
      hit.on('pointerout', () => this.tooltip.hide());
      wrap.addChild(hit);
      this.addCaption(wrap, el, fx, fy + padH + 2);
      return;
    }

    // Button: toggles the bound param between min and max.
    const btnH = el.h - (el.label ? 16 : 0);
    const redraw = () => {
      const on = this.norm(el.moduleId, el.paramId) > 0.5;
      g.clear();
      g.alpha = dim;
      g.roundRect(fx, fy, el.w, btnH, 8)
        .fill(on ? accent() : theme.button)
        .stroke({ width: 2, color: on ? theme.text : theme.moduleStroke });
    };
    redraw();
    this.liveDraws.push({ key: () => `${bound()?.value ?? NaN}:${accent()}`, redraw, last: '' });

    const hit = new Graphics().rect(fx, fy, el.w, btnH).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const b = bound();
      if (!b) return;
      appState.beginUndoable();
      this.setNorm(b.moduleId, b.spec, b.paramId, this.norm(el.moduleId, el.paramId) > 0.5 ? 0 : 1);
      redraw();
    });
    hit.on('pointerover', (e) =>
      this.tooltip.show(this.elementTip(el, [el.label ?? 'Button', 'Click to toggle.']), e.clientX, e.clientY),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    wrap.addChild(hit);
    this.addCaption(wrap, el, fx, fy + btnH + 2);
  }

  /** 'view' element: live embed of a member module's tile or a child group's
   * face (headless, title bar cropped, uniform-scaled + letterboxed). */
  private buildViewElement(el: FaceElement, wrap: Container, fx: number, fy: number): void {
    const mod = el.moduleId ? appState.graph.modules.get(el.moduleId) : undefined;
    if (!mod && el.groupId && el.groupId !== this.group.id) {
      this.buildGroupViewElement(el, el.groupId, wrap, fx, fy);
      return;
    }
    if (!mod) {
      // Unbound (or P2 group target) — placeholder matching the editor's.
      const g = new Graphics()
        .roundRect(fx, fy, el.w, el.h, 5)
        .fill(theme.inset)
        .stroke({ width: 1, color: theme.moduleStroke });
      g.alpha = 0.5;
      g.eventMode = 'static';
      g.on('pointerover', (e) =>
        this.tooltip.show(
          [el.label ?? 'View', 'Unbound — open the face editor (🎛) to bind it.'],
          e.clientX,
          e.clientY,
        ),
      );
      g.on('pointerout', () => this.tooltip.hide());
      wrap.addChild(g);
      const t = new Text({ text: '🗔', style: { fontSize: 18, fill: theme.textDim } });
      t.anchor.set(0.5);
      t.position.set(fx + el.w / 2, fy + el.h / 2);
      t.eventMode = 'none';
      wrap.addChild(t);
      this.addCaption(wrap, el, fx, fy + el.h + 2);
      return;
    }

    const def = appState.graph.def(mod.type);
    const onOpen =
      mod.type === 'composer'
        ? () => appState.openComposer(mod.id)
        : mod.type === 'visualizer'
          ? () => appState.openVisEditor(mod.id)
          : undefined;
    const mv = new ModuleView(mod, def, NOOP_PORT_HANDLERS, this.tooltip, {
      headless: true,
      onOpen,
    });
    // Visible content = tile minus its title strip; shift up so the strip
    // lands above the mask, center the rest in the element rect.
    const contentH = mv.h - MODULE_TITLE_H;
    const s = Math.min(el.w / mv.w, el.h / contentH);
    const ex = fx + (el.w - mv.w * s) / 2;
    const ey = fy + (el.h - contentH * s) / 2 - MODULE_TITLE_H * s;
    mv.position.set(ex, ey);
    mv.scale.set(s);
    const mask = new Graphics().rect(fx, fy, el.w, el.h).fill(0xffffff);
    wrap.addChild(mask);
    mv.mask = mask;
    wrap.addChild(mv);
    // Overlay anchoring ignores rotation — anchored panels don't rotate.
    this.embedded.push({
      view: mv,
      rect: { x: el.x + el.w / 2 + ex, y: TITLE_H + el.y + el.h / 2 + ey, scale: s },
    });
    this.addCaption(wrap, el, fx, fy + el.h + 2);
  }

  /** 'view' element bound to a child group: its designed face as a live
   * sub-panel (headless GroupView; containment tree keeps this acyclic). */
  private buildGroupViewElement(el: FaceElement, childId: string, wrap: Container, fx: number, fy: number): void {
    const child = appState.graph.groups.get(childId);
    if (!child?.face) {
      const g = new Graphics()
        .roundRect(fx, fy, el.w, el.h, 5)
        .fill(theme.inset)
        .stroke({ width: 1, color: theme.moduleStroke });
      g.alpha = 0.5;
      g.eventMode = 'static';
      g.on('pointerover', (e) =>
        this.tooltip.show(
          [el.label ?? child?.name ?? 'Sub-panel', 'This group has no face yet — design one (🎛) to embed it.'],
          e.clientX,
          e.clientY,
        ),
      );
      g.on('pointerout', () => this.tooltip.hide());
      wrap.addChild(g);
      const t = new Text({ text: `▣ ${child?.name ?? '?'}`, style: { fontSize: 11, fill: theme.textDim } });
      t.anchor.set(0.5);
      t.position.set(fx + el.w / 2, fy + el.h / 2);
      t.eventMode = 'none';
      wrap.addChild(t);
      this.addCaption(wrap, el, fx, fy + el.h + 2);
      return;
    }

    const gv = new GroupView(child, [], NOOP_GROUP_HANDLERS, this.tooltip, {
      headless: true,
      onOpen: () => {
        // Drill in: expand the child, and the host tile so it's visible.
        if (child.collapsed) appState.toggleGroupCollapsed(childId);
        if (this.group.collapsed) appState.toggleGroupCollapsed(this.group.id);
      },
    });
    const contentH = gv.tileHeight - TITLE_H;
    const s = Math.min(el.w / gv.tileWidth, el.h / contentH);
    const ex = fx + (el.w - gv.tileWidth * s) / 2;
    const ey = fy + (el.h - contentH * s) / 2 - TITLE_H * s;
    gv.position.set(ex, ey);
    gv.scale.set(s);
    const mask = new Graphics().rect(fx, fy, el.w, el.h).fill(0xffffff);
    wrap.addChild(mask);
    gv.mask = mask;
    wrap.addChild(gv);
    this.embedded.push({
      view: gv,
      rect: { x: el.x + el.w / 2 + ex, y: TITLE_H + el.y + el.h / 2 + ey, scale: s },
    });
    this.addCaption(wrap, el, fx, fy + el.h + 2);
  }

  /** Tile-local rect of the embedded tile for moduleId (overlay anchoring) —
   * nested sub-panels are searched recursively, transforms composed. */
  embedRect(moduleId: string): { x: number; y: number; w: number; h: number; scale: number } | null {
    for (const e of this.embedded) {
      if (e.view instanceof ModuleView) {
        if (e.view.instance.id !== moduleId) continue;
        return { x: e.rect.x, y: e.rect.y, w: e.view.w, h: e.view.h, scale: e.rect.scale };
      }
      const r = e.view.embedRect(moduleId);
      if (r) {
        return {
          x: e.rect.x + r.x * e.rect.scale,
          y: e.rect.y + r.y * e.rect.scale,
          w: r.w,
          h: r.h,
          scale: e.rect.scale * r.scale,
        };
      }
    }
    return null;
  }

  /** Forward param refreshes to embedded tiles (recursing into sub-panels). */
  refreshParams(): void {
    for (const e of this.embedded) e.view.refreshParams();
  }

  /** Pop a freshly inserted faced group tile into existence (AI import). */
  popIn(): void {
    this.popFrom = { x: this.position.x, y: this.position.y };
    this.popUntil = performance.now() + GroupView.POP_MS;
    this.scale.set(0.001);
    this.alpha = 0;
  }

  cancelPop(): void {
    if (this.popUntil === 0) return;
    this.popUntil = 0;
    this.scale.set(1);
    this.alpha = 1;
    this.position.set(this.popFrom.x, this.popFrom.y);
  }

  advancePop(now: number): void {
    if (this.popUntil === 0) return;
    const remaining = this.popUntil - now;
    if (remaining <= 0) {
      this.cancelPop();
      return;
    }
    const t = 1 - remaining / GroupView.POP_MS;
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const u = t - 1;
    const s = 1 + c3 * u * u * u + c1 * u * u;
    this.scale.set(s);
    this.alpha = Math.min(1, t * 3);
    this.position.set(
      this.popFrom.x + (1 - s) * (this.tileWidth / 2),
      this.popFrom.y + (1 - s) * (this.tileHeight / 2),
    );
  }

  /** Resolved tint for this group's face accents (own pole, then ancestors),
   * falling back to the control type color. */
  private resolvedTint(): number {
    return appState.tintForGroup(this.group.id) ?? PORT_TYPE_COLORS.control;
  }

  /** Canvas ticker: refresh meters/readouts and externally-changed controls. */
  updateLive(): void {
    for (const d of this.liveDraws) {
      const k = d.key();
      if (k !== d.last) {
        d.last = k;
        d.redraw();
      }
    }
    for (const e of this.embedded) {
      if (e.view instanceof ModuleView) e.view.setLiveColor(appState.tintFor(e.view.instance.id));
      e.view.updateLive();
    }
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
