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
import { PORT_RADIUS } from './ModuleView';
import type { Tooltip } from './Tooltip';

const TITLE_H = 24;

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
  private popUntil = 0;
  private popFrom = { x: 0, y: 0 };
  private static readonly POP_MS = 340;

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
    const face = this.group.face;
    const inputs = this.boundaryPorts.filter((p) => p.direction === 'in');
    const outputs = this.boundaryPorts.filter((p) => p.direction === 'out');
    const rows = Math.max(inputs.length, outputs.length, 1);
    if (face) {
      this.tileWidth = face.width;
      this.tileHeight = TITLE_H + face.height;
    } else {
      this.tileHeight = TITLE_H + 18 + rows * 26;
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

    if (face) {
      for (const el of face.elements) this.buildFaceElement(el);
    }

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

  // -- face elements (core/face.ts) -----------------------------------------

  /** Live-updating element redraws, run from the canvas ticker. */
  private liveDraws: Array<{ key: () => string; redraw: () => void; last: string }> = [];

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
  private addCaption(el: FaceElement, fx: number, y: number): void {
    if (!el.label) return;
    const t = new Text({ text: el.label, style: { fontSize: 10, fill: theme.textDim } });
    t.anchor.set(0.5, 0);
    t.position.set(fx + el.w / 2, y);
    t.eventMode = 'none';
    this.addChild(t);
  }

  private buildFaceElement(el: FaceElement): void {
    const fx = el.x;
    const fy = TITLE_H + el.y;

    if (el.kind === 'label') {
      const t = new Text({
        text: el.text ?? '',
        style: { fontSize: el.size ?? 13, fill: el.color ?? theme.text },
      });
      t.position.set(fx, fy);
      t.eventMode = 'none';
      this.addChild(t);
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
        this.addChild(sprite);
      };
      if (faceTexture(el.assetId, apply)) apply();
      return;
    }

    const g = new Graphics();
    this.addChild(g);

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
      this.addCaption(el, fx, fy + el.h + 2);
      return;
    }

    if (el.kind === 'readout') {
      g.roundRect(fx, fy, el.w, el.h, 3).fill(theme.inset);
      const t = new Text({ text: '—', style: { fontSize: 11, fill: theme.text } });
      t.anchor.set(0.5);
      t.position.set(fx + el.w / 2, fy + el.h / 2);
      t.eventMode = 'none';
      this.addChild(t);
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
      this.addCaption(el, fx, fy + el.h + 2);
      return;
    }

    // Interactive controls: knob / slider / xy / button.
    const bound = () => this.boundParam(el.moduleId, el.paramId);
    const dim = bound() ? 1 : 0.35;

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
        g.arc(cx, cy, r, a0, a1).stroke({ width: 3, color: theme.inset });
        g.arc(cx, cy, r, a0, av).stroke({ width: 3, color: PORT_TYPE_COLORS.control });
        g.moveTo(cx + Math.cos(av) * r * 0.3, cy + Math.sin(av) * r * 0.3)
          .lineTo(cx + Math.cos(av) * r * 0.72, cy + Math.sin(av) * r * 0.72)
          .stroke({ width: 2, color: theme.text });
      };
      redraw();
      this.liveDraws.push({ key: () => String(bound()?.value ?? NaN), redraw, last: '' });

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
      this.addChild(hit);
      this.addCaption(el, fx, fy + el.h - 12);
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
          g.roundRect(fx, fy + el.h / 2 - 5, el.w * v, 10, 4).fill(PORT_TYPE_COLORS.control);
          g.roundRect(fx + el.w * v - 5, fy + el.h / 2 - 11, 10, 22, 3)
            .fill(theme.button).stroke({ width: 1, color: theme.text });
        } else {
          g.roundRect(fx + el.w / 2 - 5, fy, 10, el.h, 4).fill(theme.inset);
          g.roundRect(fx + el.w / 2 - 5, fy + el.h * (1 - v), 10, el.h * v, 4).fill(PORT_TYPE_COLORS.control);
          g.roundRect(fx + el.w / 2 - 11, fy + el.h * (1 - v) - 5, 22, 10, 3)
            .fill(theme.button).stroke({ width: 1, color: theme.text });
        }
      };
      redraw();
      this.liveDraws.push({ key: () => String(bound()?.value ?? NaN), redraw, last: '' });

      const hit = new Graphics().rect(fx - 4, fy - 4, el.w + 8, el.h + 8).fill({ color: 0xffffff, alpha: 0.001 });
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.on('pointerdown', (e) => {
        e.stopPropagation();
        const b = bound();
        if (!b) return;
        appState.beginUndoable();
        const local = this.toLocal(e.global);
        this.setNorm(b.moduleId, b.spec, b.paramId, horiz ? (local.x - fx) / el.w : 1 - (local.y - fy) / el.h);
        redraw();
        const start = this.norm(el.moduleId, el.paramId);
        const scale = this.worldTransform.a || 1;
        const sx = e.clientX;
        const sy = e.clientY;
        const onMove = (ev: PointerEvent) => {
          const d = horiz ? (ev.clientX - sx) / scale / el.w : -(ev.clientY - sy) / scale / el.h;
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
      this.addChild(hit);
      this.addCaption(el, fx, fy + el.h + 2);
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
        g.circle(px, py, 7).fill(PORT_TYPE_COLORS.control).stroke({ width: 2, color: theme.text });
      };
      redraw();
      this.liveDraws.push({
        key: () => `${bound()?.value ?? NaN}/${boundY()?.value ?? NaN}`,
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
        const first = this.toLocal(e.global);
        apply(first.x, first.y);
        const scale = this.worldTransform.a || 1;
        const sx = e.clientX;
        const sy = e.clientY;
        const onMove = (ev: PointerEvent) =>
          apply(first.x + (ev.clientX - sx) / scale, first.y + (ev.clientY - sy) / scale);
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
      this.addChild(hit);
      this.addCaption(el, fx, fy + padH + 2);
      return;
    }

    // Button: toggles the bound param between min and max.
    const btnH = el.h - (el.label ? 16 : 0);
    const redraw = () => {
      const on = this.norm(el.moduleId, el.paramId) > 0.5;
      g.clear();
      g.alpha = dim;
      g.roundRect(fx, fy, el.w, btnH, 8)
        .fill(on ? PORT_TYPE_COLORS.control : theme.button)
        .stroke({ width: 2, color: on ? theme.text : theme.moduleStroke });
    };
    redraw();
    this.liveDraws.push({ key: () => String(bound()?.value ?? NaN), redraw, last: '' });

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
    this.addChild(hit);
    this.addCaption(el, fx, fy + btnH + 2);
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

  /** Canvas ticker: refresh meters/readouts and externally-changed controls. */
  updateLive(): void {
    for (const d of this.liveDraws) {
      const k = d.key();
      if (k !== d.last) {
        d.last = k;
        d.redraw();
      }
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
