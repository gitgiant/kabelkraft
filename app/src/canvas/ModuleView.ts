/**
 * One module's visual on the patch canvas: resizable tile body, typed port
 * dots (inputs left, outputs right — PRD §5), knob/selector/fader controls
 * for every param (drag to change, double-click resets to default,
 * shift-double-click types a value), plus type-specific faces (keyboard keys,
 * transport buttons, meter bars, step grids…). Faces stretch with the tile.
 */

import { Container, FederatedPointerEvent, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import type { ModuleDef, ParamSpec, PortSpec } from '../core/module';
import type { ModuleInstance } from '../core/module';
import type { ControlCurve } from '../core/types';
import { PORT_TYPE_COLORS } from '../core/types';
import {
  MODMATRIX_SIZE,
  SEQ_PITCH_MAX,
  SEQ_PITCH_MIN,
  WAVEFORMS,
  type SeqStep,
} from '../core/registry';
import { clipFromData } from '../core/composer';
import { hexToRgbInt, hslToRgbInt, rgbIntToHex, rgbIntToHsl } from '../core/color';
import { bandCoefs, biquadResponseDb, chainResponseDb, vcfCoefs } from '../core/eqmath';
import { appState } from '../state';
import { theme } from '../theme';
import { binFrac } from '../visual/features';
import { approximateScene, visGraphOf } from '../visual/migrate';
import { ContainerRenderer, graphSupported, webgpuAvailable } from '../visual/runtime';
import { RESIZE_DIRS, inResizeBand, resizeCursor, resizeSize, type ResizeDir } from './resize';
import type { Tooltip } from './Tooltip';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Shared GPU tile thumbnails: one offscreen renderer per visualizer module,
 * reused across tile rebuilds, updated at ¼ ticker rate. Pruned on delete.
 */
interface VisThumb {
  canvas: OffscreenCanvas;
  renderer: ContainerRenderer | null;
  texture: Texture;
  failed: boolean;
}

const visThumbs = new Map<string, VisThumb>();
let visThumbPruner = false;

function visThumb(moduleId: string, aspect: number): VisThumb {
  if (!visThumbPruner) {
    visThumbPruner = true;
    appState.on('graphChanged', () => {
      for (const [id, t] of visThumbs) {
        if (!appState.graph.modules.has(id)) {
          t.renderer?.destroy();
          t.texture.destroy(true);
          visThumbs.delete(id);
        }
      }
    });
  }
  let t = visThumbs.get(moduleId);
  if (!t) {
    const canvas = new OffscreenCanvas(256, Math.max(64, Math.min(512, Math.round(256 * aspect))));
    t = { canvas, renderer: null, texture: Texture.from(canvas), failed: false };
    visThumbs.set(moduleId, t);
    void ContainerRenderer.create(canvas).then((r) => {
      const entry = visThumbs.get(moduleId);
      if (entry === t) {
        t!.renderer = r;
        t!.failed = r === null;
      } else r?.destroy();
    });
  }
  return t;
}

/** Minimal HSL→hex for particle colors. */
export function hslToHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

function noteName(pitch: number): string {
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

export const PORT_RADIUS = 7;
const TITLE_H = 24;
/** Minimum knob-grid cell width / nominal fixed-band cell height. */
const CELL_W = 64;
const CELL_H = 60;

const CTRL_HINT =
  'Drag. Double-click: default. Shift-double-click: type. Alt-click: MIDI learn.';

export interface PortHandlers {
  onPortDown(moduleId: string, portId: string, e: FederatedPointerEvent): void;
  onPortUp(moduleId: string, portId: string, e: FederatedPointerEvent): void;
  onBodyDown(view: ModuleView, e: FederatedPointerEvent): void;
}

/**
 * A drawable, draggable scalar control — a ParamSpec, a drum-pad field, or a
 * Knob/Slider module's scaled value. All knob/selector/fader widgets speak
 * this interface so gestures (drag, default, typing, learn) stay uniform.
 */
interface CtrlSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
  curve?: ControlCurve;
  unit?: string;
  options?: string[];
  integer?: boolean;
  format?: (v: number) => string;
  get(): number;
  set(v: number): void;
  /** Param id for MIDI/face learn; undefined disables learn on this control. */
  learnId?: string;
}

interface KeySpec {
  semitone: number;
  black: boolean;
}

// One octave, C to B.
const KEYS: KeySpec[] = [
  { semitone: 0, black: false }, { semitone: 1, black: true },
  { semitone: 2, black: false }, { semitone: 3, black: true },
  { semitone: 4, black: false }, { semitone: 5, black: false },
  { semitone: 6, black: true }, { semitone: 7, black: false },
  { semitone: 8, black: true }, { semitone: 9, black: false },
  { semitone: 10, black: true }, { semitone: 11, black: false },
];

export class ModuleView extends Container {
  readonly portCenters = new Map<string, { x: number; y: number }>();
  private body = new Graphics();
  private portDots = new Map<string, Graphics>();
  /** Eight persistent resize hit-zones — created once, never destroyed mid-
   * gesture (re-added on every rebuild) so PixiJS hover/cursor never wedges. */
  private resizeHandles: Graphics[] = [];
  private flashTimers = new Map<string, number>();
  private selected = false;
  private popUntil = 0;
  private popFrom = { x: 0, y: 0 };
  private static readonly POP_MS = 340;

  /** Redraw closures for every control widget; run on any param change. */
  private ctrlRedraws: Array<() => void> = [];
  /** Control centers by param id — e2e and tools aim pointers with this. */
  private paramAnchors = new Map<string, { x: number; y: number }>();
  /** Live tint from an incoming color wire (packed RGB); null = none. */
  private liveColor: number | null = null;

  /** Faces whose fixed layout cannot shrink below the def's default size. */
  private static readonly FIXED_MIN_TYPES = new Set(['transport']);

  constructor(
    readonly instance: ModuleInstance,
    readonly def: ModuleDef,
    private handlers: PortHandlers,
    private tooltip: Tooltip,
  ) {
    super();
    this.position.set(instance.x, instance.y);
    this.rebuild();
  }

  // -- size ----------------------------------------------------------------

  /** Current tile width: instance override clamped to sane bounds. */
  get w(): number {
    return this.clampSize(this.instance.w ?? this.def.width, this.def.width);
  }

  get h(): number {
    return this.clampSize(this.instance.h ?? this.def.height, this.def.height);
  }

  private clampSize(v: number, base: number): number {
    const lo = ModuleView.FIXED_MIN_TYPES.has(this.instance.type)
      ? base
      : Math.max(80, base * 0.7);
    return Math.min(base * 3, Math.max(lo, this.rollMin(base), v));
  }

  /** While the piano roll is open inside a composer, the tile can't shrink
   * below a usable editor size (shrink via the title-bar toggle instead). */
  private rollMin(base: number): number {
    if (this.instance.type !== 'composer' || !appState.composerOpen.has(this.instance.id)) return 0;
    return base === this.def.width ? 600 : 400;
  }

  // -- construction ----------------------------------------------------------

  /** Tear down and re-create all children — after a resize or theme change. */
  rebuild(): void {
    for (const t of this.flashTimers.values()) clearTimeout(t);
    this.flashTimers.clear();
    const kids = [...this.children];
    this.removeChildren();
    for (const k of kids) {
      if (this.resizeHandles.includes(k as Graphics)) continue; // persistent — survive rebuild
      k.destroy({ children: true });
    }

    this.portCenters.clear();
    this.portDots.clear();
    this.ctrlRedraws = [];
    this.paramAnchors.clear();
    this.meterBar = null;
    this.clipDot = null;
    this.clipped = false;
    this.grBar = null;
    this.vcfCurveG = null;
    this.ctrlG = null;
    this.ctrlText = null;
    this.compG = null;
    this.lastCompPos = -1;
    this.lastCompData = null;
    this.visG = null;
    this.midiDeviceText = null;
    this.peqPlot = null;
    this.peqSpectrumG = null;
    this.peqDots = [];
    this.lastSpectrum = null;
    this.wtRowText = null;
    this.recButton = null;
    this.recLabel = null;
    this.recElapsed = null;
    this.waveform = null;
    this.sampleNameText = null;
    this.stepGrid = null;
    this.lastDrawnStep = -1;
    this.colorPrevG = null;
    this.lastPrevColor = -2;

    this.body = new Graphics();
    this.addChild(this.body);
    this.drawBody(this.selected);
    // Handles sit just above the body so ports/face/title (added next) win hit
    // priority in their bands, while the handles still beat body-drag on edges.
    this.mountResizeHandles();
    this.buildTitle();
    this.buildPorts();
    this.buildFace();
  }

  private drawBody(selected: boolean): void {
    const w = this.w;
    const h = this.h;
    const glow = this.liveColor;
    this.body.clear();
    this.body
      .roundRect(0, 0, w, h, 8)
      .fill(selected ? theme.moduleBodySelected : theme.moduleBody)
      .stroke({
        width: selected ? 2 : glow !== null ? 1.5 : 1,
        color: selected ? theme.selectedStroke : glow ?? theme.moduleStroke,
      });
    this.body.roundRect(0, 0, w, TITLE_H, 8).fill(theme.moduleTitle);
    this.body.rect(0, TITLE_H - 8, w, 8).fill(theme.moduleTitle);
    const stripe = glow ?? this.instance.color;
    if (stripe !== undefined) {
      this.body.rect(0, TITLE_H, w, 3).fill(stripe);
    }
    // Resize grip glyph (se corner) — discoverability for the all-sides handles.
    this.body.moveTo(w - 13, h - 4).lineTo(w - 4, h - 13)
      .stroke({ width: 1.5, color: theme.textDim, alpha: 0.8 });
    this.body.moveTo(w - 8, h - 4).lineTo(w - 4, h - 8)
      .stroke({ width: 1.5, color: theme.textDim, alpha: 0.8 });
  }

  /** Tint from an incoming color wire; redraws accent + body when it changes. */
  setLiveColor(color: number | null): void {
    if (color === this.liveColor) return;
    this.liveColor = color;
    this.drawBody(this.selected);
    this.refreshParams();
  }

  /** Accent for controller faces: the live color wire, else the type color. */
  private accent(): number {
    return this.liveColor ?? PORT_TYPE_COLORS.control;
  }

  private buildTitle(): void {
    const title = new Text({
      text: this.instance.label ?? this.def.name,
      style: { fontSize: 12, fill: theme.text, fontWeight: 'bold' },
    });
    title.position.set(8, 5);
    this.addChild(title);

    // Composer: group-tile-style title-bar toggle — ⛶ opens the roll in
    // place, ⤡ shrinks back to the compact preview tile.
    if (this.instance.type === 'composer') {
      const open = appState.composerOpen.has(this.instance.id);
      const glyph = new Text({
        text: open ? '⤡' : '⛶',
        style: { fontSize: 11, fill: theme.textDim },
      });
      glyph.anchor.set(1, 0);
      glyph.position.set(this.w - 8, 6);
      glyph.eventMode = 'none';
      this.addChild(glyph);
      const hit = new Graphics().rect(this.w - 24, 2, 20, 20).fill({ color: 0xffffff, alpha: 0.001 });
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.on('pointerdown', (e) => {
        e.stopPropagation();
        if (appState.composerOpen.has(this.instance.id)) appState.closeComposer(this.instance.id);
        else appState.openComposer(this.instance.id);
      });
      hit.on('pointerover', (e) =>
        this.tooltip.show(
          open
            ? ['Shrink', 'Collapse back to the compact clip tile.']
            : ['Open piano roll', 'Expand the editor inside the module.'],
          e.clientX,
          e.clientY,
        ),
      );
      hit.on('pointerout', () => this.tooltip.hide());
      this.addChild(hit);
    }

    this.body.eventMode = 'static';
    this.body.cursor = 'grab';
    this.body.on('pointerdown', (e) => this.handlers.onBodyDown(this, e));
    this.body.on('pointerover', (e) =>
      this.tooltip.show(
        [this.instance.label ?? this.def.name, this.def.description],
        e.clientX,
        e.clientY,
      ),
    );
    this.body.on('pointerout', () => this.tooltip.hide());
  }

  private buildPorts(): void {
    const inputs = this.def.ports.filter((p) => p.direction === 'in');
    const outputs = this.def.ports.filter((p) => p.direction === 'out');
    const place = (ports: PortSpec[], x: number) => {
      ports.forEach((port, i) => {
        const y = TITLE_H + 18 + i * 26;
        this.portCenters.set(port.id, { x, y });
        const dot = new Graphics();
        this.drawPortDot(dot, port, false);
        dot.position.set(x, y);
        dot.eventMode = 'static';
        dot.cursor = 'crosshair';
        // Generous hit area — PRD §13 touch targets.
        dot.hitArea = { contains: (px: number, py: number) => px * px + py * py < 20 * 20 };
        dot.on('pointerdown', (e) => {
          e.stopPropagation();
          this.handlers.onPortDown(this.instance.id, port.id, e);
        });
        dot.on('pointerup', (e) => {
          e.stopPropagation();
          this.handlers.onPortUp(this.instance.id, port.id, e);
        });
        dot.on('pointerover', (e) => {
          this.tooltip.show(
            [`${port.label} — ${port.type} ${port.direction}`, port.description],
            e.clientX,
            e.clientY,
          );
        });
        dot.on('pointerout', () => this.tooltip.hide());
        this.addChild(dot);
        this.portDots.set(port.id, dot);
      });
    };
    place(inputs, 0);
    place(outputs, this.w);
  }

  private drawPortDot(dot: Graphics, port: PortSpec, highlight: boolean): void {
    dot.clear();
    dot
      .circle(0, 0, highlight ? PORT_RADIUS + 3 : PORT_RADIUS)
      .fill(PORT_TYPE_COLORS[port.type])
      .stroke({ width: 2, color: highlight ? 0xffffff : 0x16161c });
  }

  setPortHighlight(portId: string, on: boolean): void {
    const dot = this.portDots.get(portId);
    const port = this.def.ports.find((p) => p.id === portId);
    if (dot && port) this.drawPortDot(dot, port, on);
  }

  /** Brief red flash on a port that rejected a wire (PRD §4.3). */
  flashPortRejection(portId: string): void {
    const dot = this.portDots.get(portId);
    if (!dot) return;
    const prev = this.flashTimers.get(portId);
    if (prev !== undefined) clearTimeout(prev);
    dot.clear().circle(0, 0, PORT_RADIUS + 3).fill(0xff3030).stroke({ width: 2, color: 0xffffff });
    this.flashTimers.set(
      portId,
      window.setTimeout(() => this.setPortHighlight(portId, false), 350),
    );
  }

  // -- resize ------------------------------------------------------------------

  /** Create the 8 persistent hit-zones once, then (re-)attach them on top of
   * the body. Their hit-tests read this.w/this.h live, so no per-frame layout. */
  private mountResizeHandles(): void {
    if (this.resizeHandles.length === 0) {
      for (const dir of RESIZE_DIRS) {
        const g = new Graphics();
        g.eventMode = 'static';
        g.cursor = resizeCursor(dir);
        g.hitArea = { contains: (px, py) => inResizeBand(dir, px, py, this.w, this.h) };
        g.on('pointerdown', (e) => {
          e.stopPropagation();
          if (e.detail >= 2) {
            appState.beginUndoable();
            delete this.instance.w;
            delete this.instance.h;
            this.rebuild();
            return;
          }
          this.beginResize(dir, e);
        });
        g.on('pointerover', (ev) =>
          this.tooltip.show(['Resize', 'Drag any edge or corner. Double-click: default size.'], ev.clientX, ev.clientY),
        );
        g.on('pointerout', () => this.tooltip.hide());
        this.resizeHandles.push(g);
      }
    }
    for (const g of this.resizeHandles) this.addChild(g);
  }

  private beginResize(dir: ResizeDir, e: FederatedPointerEvent): void {
    appState.beginUndoable(); // whole resize = one undo step
    const startW = this.w;
    const startH = this.h;
    const startX = this.instance.x;
    const startY = this.instance.y;
    const sx = e.clientX;
    const sy = e.clientY;
    const scale = this.worldTransform.a || 1;
    let raf = 0;
    // Anchor the opposite edge for n/w drags using the *clamped* size, so a
    // size hitting its min/max doesn't drift the fixed edge.
    const anchor = () => {
      if (dir.includes('w')) this.instance.x = startX + startW - this.w;
      if (dir.includes('n')) this.instance.y = startY + startH - this.h;
      this.position.set(this.instance.x, this.instance.y);
    };
    const onMove = (ev: PointerEvent) => {
      const { w, h } = resizeSize(dir, (ev.clientX - sx) / scale, (ev.clientY - sy) / scale, startW, startH);
      this.instance.w = w;
      this.instance.h = h;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          anchor();
          this.rebuild();
        });
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (raf) cancelAnimationFrame(raf);
      // Store the clamped size so saved patches stay in bounds.
      this.instance.w = this.w;
      this.instance.h = this.h;
      anchor();
      this.rebuild();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // -- pop-in animation ----------------------------------------------------------

  /** Pop a freshly inserted module into existence (AI import, PRD §10). */
  popIn(): void {
    this.popFrom = { x: this.position.x, y: this.position.y };
    this.popUntil = performance.now() + ModuleView.POP_MS;
    this.scale.set(0.001);
    this.alpha = 0;
  }

  /** Snap an in-flight pop to its resting transform (e.g. if the user grabs it). */
  cancelPop(): void {
    if (this.popUntil === 0) return;
    this.popUntil = 0;
    this.scale.set(1);
    this.alpha = 1;
    this.position.set(this.popFrom.x, this.popFrom.y);
  }

  /** Advance the pop animation; called once per frame while active. */
  advancePop(now: number): void {
    if (this.popUntil === 0) return;
    const remaining = this.popUntil - now;
    if (remaining <= 0) {
      this.cancelPop();
      return;
    }
    const t = 1 - remaining / ModuleView.POP_MS;
    // ease-out-back: grows past 1 then settles, for a tactile "pop".
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const u = t - 1;
    const s = 1 + c3 * u * u * u + c1 * u * u;
    this.scale.set(s);
    this.alpha = Math.min(1, t * 3);
    // Scale about the tile centre without disturbing the logical position.
    this.position.set(
      this.popFrom.x + (1 - s) * (this.w / 2),
      this.popFrom.y + (1 - s) * (this.h / 2),
    );
  }

  // -- control specs -----------------------------------------------------------

  /** Visible params for the face (no mode-scoping now the monolith synth is gone). */
  private visibleParams(): ParamSpec[] {
    return this.def.params;
  }

  /** No module rebuilds its face on a param change since the monolith synth left. */
  faceStale(): boolean {
    return false;
  }

  private paramCtrl(p: ParamSpec): CtrlSpec {
    return {
      key: p.id,
      label: p.label,
      min: p.min,
      max: p.max,
      default: p.default,
      curve: p.curve,
      unit: p.unit,
      options: p.options,
      get: () => this.instance.params[p.id] ?? p.default,
      set: (v) => appState.setParam(this.instance.id, p.id, v),
      learnId: p.id,
    };
  }

  private paramSpec(id: string): ParamSpec {
    return this.def.params.find((p) => p.id === id)!;
  }

  /** Control center for a param id (e2e drives the mouse with this). */
  paramAnchor(paramId: string): { x: number; y: number } | null {
    return this.paramAnchors.get(paramId) ?? null;
  }

  /** Normalized 0–1 position of a control value, honoring its display curve. */
  private ctrlNorm(c: CtrlSpec, v: number): number {
    if (c.curve === 'exp' && c.min > 0) return Math.log(v / c.min) / Math.log(c.max / c.min);
    return (v - c.min) / (c.max - c.min);
  }

  private ctrlFromNorm(c: CtrlSpec, n: number): number {
    const k = Math.min(1, Math.max(0, n));
    let v: number;
    if (c.curve === 'exp' && c.min > 0) v = c.min * Math.pow(c.max / c.min, k);
    else v = c.min + k * (c.max - c.min);
    if (c.options || c.integer) v = Math.round(v);
    return v;
  }

  private formatCtrl(c: CtrlSpec): string {
    const v = c.get();
    if (c.format) return c.format(v);
    if (c.options) return c.options[Math.round(v)] ?? String(v);
    const text = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
    return c.unit ? `${text} ${c.unit}` : text;
  }

  /** Raw position readout: "62/100", selectors "3/5". */
  private ctrlRaw(c: CtrlSpec): string {
    if (c.options) return `${Math.round(c.get()) + 1}/${c.options.length}`;
    const n = Math.min(1, Math.max(0, this.ctrlNorm(c, c.get())));
    return `${Math.round(n * 100)}/100`;
  }

  private ctrlTipTitle(c: CtrlSpec): string {
    return `${c.label}: ${this.formatCtrl(c)} (${this.ctrlRaw(c)})`;
  }

  private runCtrlRedraws(): void {
    for (const fn of this.ctrlRedraws) fn();
  }

  /**
   * Shared gesture preamble: face learn, MIDI learn (alt), double-click
   * default, shift-double-click typed entry. True = event consumed.
   */
  private ctrlPreamble(c: CtrlSpec, e: FederatedPointerEvent): boolean {
    if (c.learnId && appState.faceLearn && appState.completeFaceLearn(this.instance.id, c.learnId)) {
      return true;
    }
    if (e.altKey && c.learnId) {
      appState.armMidiLearn(this.instance.id, c.learnId);
      return true;
    }
    if (e.detail >= 2) {
      if (e.shiftKey && !c.options) {
        const raw = window.prompt(
          `${c.label} (${c.min}–${c.max}${c.unit ? ' ' + c.unit : ''})`,
          String(c.get()),
        );
        const v = Number(raw);
        if (raw === null || !Number.isFinite(v)) return true;
        appState.beginUndoable();
        c.set(Math.min(c.max, Math.max(c.min, v)));
      } else {
        appState.beginUndoable();
        c.set(c.default);
      }
      this.refreshParams();
      return true;
    }
    return false;
  }

  // -- control widgets -----------------------------------------------------------

  /** Rotary knob for a continuous control. */
  private buildKnob(c: CtrlSpec, cx: number, cy: number, r: number): void {
    this.paramAnchors.set(c.key, { x: cx, y: cy });
    const g = new Graphics();
    this.addChild(g);
    const label = new Text({ text: c.label, style: { fontSize: 9, fill: theme.textDim } });
    label.anchor.set(0.5, 1);
    label.position.set(cx, cy - r - 3);
    label.eventMode = 'none';
    this.addChild(label);
    const value = new Text({ text: '', style: { fontSize: 9, fill: theme.text } });
    value.anchor.set(0.5, 0);
    value.position.set(cx, cy + r + 2);
    value.eventMode = 'none';
    this.addChild(value);

    const redraw = () => {
      const n = Math.min(1, Math.max(0, this.ctrlNorm(c, c.get())));
      const a0 = Math.PI * 0.75;
      const a1 = Math.PI * 2.25;
      const av = a0 + (a1 - a0) * n;
      g.clear();
      g.circle(cx, cy, r * 0.74).fill(theme.inset).stroke({ width: 1, color: theme.moduleStroke });
      // moveTo before each arc: without it the path connects from its
      // current point (the graphics origin), drawing stray wire-like lines.
      g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
      g.arc(cx, cy, r, a0, a1).stroke({ width: 3, color: theme.inset });
      g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
      g.arc(cx, cy, r, a0, av).stroke({ width: 3, color: PORT_TYPE_COLORS.control });
      g.moveTo(cx + Math.cos(av) * r * 0.25, cy + Math.sin(av) * r * 0.25)
        .lineTo(cx + Math.cos(av) * r * 0.66, cy + Math.sin(av) * r * 0.66)
        .stroke({ width: 2, color: theme.text });
      value.text = this.formatCtrl(c);
    };
    redraw();
    this.ctrlRedraws.push(redraw);

    const hit = new Graphics().circle(cx, cy, r + 6).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'ns-resize';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      if (this.ctrlPreamble(c, e)) return;
      appState.beginUndoable();
      const start = this.ctrlNorm(c, c.get());
      const startY = e.clientY;
      const scale = this.worldTransform.a || 1;
      const onMove = (ev: PointerEvent) => {
        c.set(this.ctrlFromNorm(c, start + (startY - ev.clientY) / scale / 120));
        this.refreshParams();
        this.tooltip.showNow([this.ctrlTipTitle(c)], ev.clientX, ev.clientY);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        this.tooltip.hide();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    hit.on('pointerover', (ev) =>
      this.tooltip.show([this.ctrlTipTitle(c), CTRL_HINT], ev.clientX, ev.clientY),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  /** Stepped selector knob for an options control (waveform, mode, …). */
  private buildSelector(c: CtrlSpec, cx: number, cy: number, r: number): void {
    this.paramAnchors.set(c.key, { x: cx, y: cy });
    const opts = c.options!;
    const g = new Graphics();
    this.addChild(g);
    const label = new Text({ text: c.label, style: { fontSize: 9, fill: theme.textDim } });
    label.anchor.set(0.5, 1);
    label.position.set(cx, cy - r - 3);
    label.eventMode = 'none';
    this.addChild(label);
    const value = new Text({ text: '', style: { fontSize: 9, fill: theme.text } });
    value.anchor.set(0.5, 0);
    value.position.set(cx, cy + r + 2);
    value.eventMode = 'none';
    this.addChild(value);

    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    const angleFor = (i: number) => a0 + (a1 - a0) * (opts.length > 1 ? i / (opts.length - 1) : 0.5);

    const redraw = () => {
      const idx = Math.min(opts.length - 1, Math.max(0, Math.round(c.get())));
      g.clear();
      g.circle(cx, cy, r * 0.74).fill(theme.inset).stroke({ width: 1, color: theme.moduleStroke });
      // Detent ticks, the active one highlighted.
      for (let i = 0; i < opts.length; i++) {
        const a = angleFor(i);
        g.moveTo(cx + Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.92)
          .lineTo(cx + Math.cos(a) * r * 1.15, cy + Math.sin(a) * r * 1.15)
          .stroke({ width: 2, color: i === idx ? PORT_TYPE_COLORS.control : theme.moduleStroke });
      }
      const av = angleFor(idx);
      g.moveTo(cx + Math.cos(av) * r * 0.2, cy + Math.sin(av) * r * 0.2)
        .lineTo(cx + Math.cos(av) * r * 0.66, cy + Math.sin(av) * r * 0.66)
        .stroke({ width: 2.5, color: theme.text });
      value.text = opts[idx] ?? '';
    };
    redraw();
    this.ctrlRedraws.push(redraw);

    const hit = new Graphics().circle(cx, cy, r + 8).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      if (this.ctrlPreamble(c, e)) return;
      appState.beginUndoable();
      const startIdx = Math.min(opts.length - 1, Math.max(0, Math.round(c.get())));
      const startY = e.clientY;
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        const dy = startY - ev.clientY;
        if (Math.abs(dy) > 3) moved = true;
        if (!moved) return;
        const idx = Math.min(opts.length - 1, Math.max(0, startIdx + Math.round(dy / 28)));
        if (idx !== Math.round(c.get())) {
          c.set(idx);
          this.refreshParams();
        }
        this.tooltip.showNow([this.ctrlTipTitle(c)], ev.clientX, ev.clientY);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        this.tooltip.hide();
        if (!moved) {
          // Plain click steps to the next option.
          c.set((startIdx + 1) % opts.length);
          this.refreshParams();
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    hit.on('pointerover', (ev) =>
      this.tooltip.show(
        [this.ctrlTipTitle(c), 'Click: next option. Drag: select. Double-click: default. Alt-click: MIDI learn.'],
        ev.clientX,
        ev.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  /** Vertical fader for a continuous control (mixer channel strips). */
  private buildFader(c: CtrlSpec, x: number, y: number, w: number, h: number): void {
    this.paramAnchors.set(c.key, { x: x + w / 2, y: y + h / 2 });
    const g = new Graphics();
    this.addChild(g);
    const label = new Text({ text: c.label, style: { fontSize: 9, fill: theme.textDim } });
    label.anchor.set(0.5, 1);
    label.position.set(x + w / 2, y - 4);
    label.eventMode = 'none';
    this.addChild(label);
    const value = new Text({ text: '', style: { fontSize: 9, fill: theme.text } });
    value.anchor.set(0.5, 0);
    value.position.set(x + w / 2, y + h + 4);
    value.eventMode = 'none';
    this.addChild(value);

    const redraw = () => {
      const n = Math.min(1, Math.max(0, this.ctrlNorm(c, c.get())));
      g.clear();
      g.roundRect(x, y, w, h, 4).fill(theme.inset).stroke({ width: 1, color: theme.moduleStroke });
      g.roundRect(x, y + h * (1 - n), w, h * n, 4).fill(PORT_TYPE_COLORS.control);
      g.roundRect(x - 6, y + h * (1 - n) - 5, w + 12, 10, 3)
        .fill(theme.button)
        .stroke({ width: 1, color: theme.text });
      value.text = this.formatCtrl(c);
    };
    redraw();
    this.ctrlRedraws.push(redraw);

    const hit = new Graphics().rect(x - 8, y - 6, w + 16, h + 12).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      if (this.ctrlPreamble(c, e)) return;
      appState.beginUndoable();
      // Jump to the click position, then track relatively.
      const local = this.toLocal(e.global);
      c.set(this.ctrlFromNorm(c, 1 - (local.y - y) / h));
      this.refreshParams();
      const start = this.ctrlNorm(c, c.get());
      const startY = e.clientY;
      const scale = this.worldTransform.a || 1;
      const onMove = (ev: PointerEvent) => {
        c.set(this.ctrlFromNorm(c, start + (startY - ev.clientY) / scale / h));
        this.refreshParams();
        this.tooltip.showNow([this.ctrlTipTitle(c)], ev.clientX, ev.clientY);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        this.tooltip.hide();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    hit.on('pointerover', (ev) =>
      this.tooltip.show([this.ctrlTipTitle(c), CTRL_HINT], ev.clientX, ev.clientY),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  /** Lay controls out in a grid filling the given rect; knobs scale to fit. */
  private buildCtrlGrid(ctrls: CtrlSpec[], x: number, y: number, w: number, h: number): void {
    if (!ctrls.length) return;
    const cols = Math.max(1, Math.min(ctrls.length, Math.floor(w / CELL_W)));
    const rows = Math.ceil(ctrls.length / cols);
    const cellW = w / cols;
    const cellH = h / rows;
    const r = Math.max(10, Math.min(20, (Math.min(cellW, cellH) - 28) / 2));
    ctrls.forEach((c, i) => {
      const cx = x + (i % cols) * cellW + cellW / 2;
      const cy = y + Math.floor(i / cols) * cellH + cellH / 2 + 2;
      if (c.options) this.buildSelector(c, cx, cy, r);
      else this.buildKnob(c, cx, cy, r);
    });
  }

  /** Height of a fixed knob band for n controls in the given width. */
  private ctrlBandH(n: number, w: number): number {
    if (!n) return 0;
    const cols = Math.max(1, Math.min(n, Math.floor(w / CELL_W)));
    return Math.ceil(n / cols) * CELL_H;
  }

  // -- face dispatch -----------------------------------------------------------

  private buildFace(): void {
    const type = this.instance.type;
    const x = 18;
    const w = this.w - 36;
    const top = TITLE_H + 10;

    // Fully custom faces.
    if (type === 'peq') {
      this.buildPeqFace(x, top, w);
      return;
    }
    if (type === 'vcf') {
      this.buildVcfFace(x, top, w);
      return;
    }
    if (type === 'knob') {
      this.buildKnobFace();
      return;
    }
    if (type === 'slider') {
      this.buildSliderFace();
      return;
    }
    if (type === 'xy') {
      this.buildXyFace();
      return;
    }
    if (type === 'button') {
      this.buildButtonFace();
      return;
    }
    if (type === 'mixer') {
      this.buildMixerFace(x, top + 12, w);
      return;
    }
    if (type === 'composer') {
      this.buildComposerFace(x, top, w);
      return;
    }
    if (type === 'levels') {
      this.buildVMeter(this.w / 2 - 12, top + 12, 24, this.h - top - 26);
      return;
    }
    if (type === 'recorder') {
      this.buildRecorderFace(x, top + 4, w - 36);
      this.buildVMeter(this.w - 32, top + 12, 14, this.h - top - 26);
      return;
    }
    if (type === 'colorgen') {
      this.buildColorGenFace(x, top, w);
      return;
    }
    if (type === 'modmatrix') {
      this.buildModMatrixFace(x, top, w);
      return;
    }

    const ctrls = this.visibleParams().map((p) => this.paramCtrl(p));

    // Vertical meters live in a right-edge column.
    let right = this.w - 18;
    if (type === 'audioOut') {
      this.buildVMeter(this.w - 30, top + 12, 14, this.h - top - 26);
      right = this.w - 44;
    }
    if (type === 'compressor' || type === 'limiter' || type === 'mbcomp') {
      this.buildGrMeter(this.w - 28, top + 12, 12, this.h - top - 26);
      right = this.w - 42;
    }

    // Bottom-anchored utility rows.
    let bottom = this.h - 12;
    if (type === 'wtosc') {
      this.buildWavetableRow(x, this.h - 22, w);
      bottom -= 24;
    }
    if (type === 'midiIn' || type === 'midiOut') {
      this.buildMidiDeviceRow(x, this.h - 24, w);
      bottom -= 26;
    }

    const gw = right - x;

    // Modules with a stretching extra face get a fixed knob band on top.
    if (type === 'keyboard') {
      const band = this.ctrlBandH(ctrls.length, gw);
      this.buildCtrlGrid(ctrls, x, top, gw, band);
      this.buildKeys(x, top + band + 4, gw);
      return;
    }
    if (type === 'transport') {
      const band = this.ctrlBandH(ctrls.length, gw);
      this.buildCtrlGrid(ctrls, x, top, gw, band);
      this.buildTransportButtons(this.w / 2 - 84, top + band + 10);
      return;
    }
    if (type === 'sequencer') {
      const band = this.ctrlBandH(ctrls.length, gw);
      this.buildCtrlGrid(ctrls, x, top, gw, band);
      this.buildStepGrid(x, top + band + 6, gw);
      return;
    }
    if (type === 'smpl') {
      const band = this.ctrlBandH(ctrls.length, gw);
      this.buildCtrlGrid(ctrls, x, top, gw, band);
      this.buildSamplerFace(x, top + band + 6, gw);
      return;
    }
    if (type === 'visualizer') {
      const band = this.ctrlBandH(ctrls.length, gw);
      this.buildCtrlGrid(ctrls, x, top, gw, band);
      this.buildVisFace(x, top + band + 4, gw);
      return;
    }
    if (type === 'stt' || type === 'textinput' || type === 'transporttext' || type === 'notenames') {
      const band = this.ctrlBandH(ctrls.length, gw);
      this.buildCtrlGrid(ctrls, x, top, gw, band);
      this.buildTextFace(x, top + band + 4, gw);
      return;
    }

    // Pure param modules: the knob grid stretches over the whole face.
    this.buildCtrlGrid(ctrls, x, top, gw, bottom - top);
  }

  // -- filter (vcf) face: knobs + response curve -----------------------------

  private vcfCurveG: Graphics | null = null;
  private vcfCurveRect = { x: 0, y: 0, w: 0, h: 0 };

  private buildVcfFace(x: number, y: number, w: number): void {
    const r = Math.max(12, Math.min(20, w / 11));
    const knobY = y + r + 16;
    this.buildSelector(this.paramCtrl(this.paramSpec('mode')), x + w * 0.125, knobY, r);
    this.buildKnob(this.paramCtrl(this.paramSpec('cutoff')), x + w * 0.375, knobY, r);
    this.buildKnob(this.paramCtrl(this.paramSpec('res')), x + w * 0.625, knobY, r);
    this.buildKnob(this.paramCtrl(this.paramSpec('amt')), x + w * 0.875, knobY, r);

    const cy = knobY + r + 26;
    this.vcfCurveRect = { x, y: cy, w, h: this.h - cy - 12 };
    this.vcfCurveG = new Graphics();
    this.addChild(this.vcfCurveG);
    this.drawVcfCurve();

    const rect = this.vcfCurveRect;
    const hit = new Graphics().rect(rect.x, rect.y, rect.w, rect.h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'crosshair';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.beginUndoable();
      const cutoff = this.paramCtrl(this.paramSpec('cutoff'));
      const res = this.paramCtrl(this.paramSpec('res'));
      const apply = (lx: number, ly: number) => {
        cutoff.set(this.ctrlFromNorm(cutoff, (lx - rect.x) / rect.w));
        res.set(this.ctrlFromNorm(res, 1 - (ly - rect.y) / rect.h));
        this.refreshParams();
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
    hit.on('pointerover', (ev) =>
      this.tooltip.show(
        ['Filter response', 'Drag: horizontal = cutoff, vertical = Q.'],
        ev.clientX,
        ev.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  /** Visual indicator: log-frequency magnitude curve of the current settings. */
  private drawVcfCurve(): void {
    if (!this.vcfCurveG) return;
    const g = this.vcfCurveG;
    const r = this.vcfCurveRect;
    const p = this.instance.params;
    const sr = appState.engine.sampleRate;
    const coefs = vcfCoefs(Math.round(p.mode ?? 0), p.cutoff ?? 1200, p.res ?? 0.2, sr);

    const F_LO = 20;
    const F_HI = 20000;
    const DB_RANGE = 30; // ±30 dB
    const yFor = (db: number) =>
      r.y + r.h / 2 - (Math.max(-DB_RANGE, Math.min(DB_RANGE, db)) / DB_RANGE) * (r.h / 2);

    g.clear();
    g.roundRect(r.x, r.y, r.w, r.h, 4).fill(theme.inset);
    g.moveTo(r.x, r.y + r.h / 2).lineTo(r.x + r.w, r.y + r.h / 2)
      .stroke({ width: 1, color: theme.moduleStroke, alpha: 0.6 });

    const N = 80;
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= N; i++) {
      const f = F_LO * Math.pow(F_HI / F_LO, i / N);
      pts.push({ x: r.x + (i / N) * r.w, y: yFor(biquadResponseDb(coefs, f, sr)) });
    }
    g.moveTo(pts[0].x, r.y + r.h);
    for (const pt of pts) g.lineTo(pt.x, pt.y);
    g.lineTo(pts[N].x, r.y + r.h);
    g.closePath();
    g.fill({ color: PORT_TYPE_COLORS.audio, alpha: 0.18 });
    g.moveTo(pts[0].x, pts[0].y);
    for (const pt of pts) g.lineTo(pt.x, pt.y);
    g.stroke({ width: 2, color: PORT_TYPE_COLORS.audio });

    // Cutoff handle.
    const cutoff = Math.min(F_HI, Math.max(F_LO, p.cutoff ?? 1200));
    const cx = r.x + (Math.log(cutoff / F_LO) / Math.log(F_HI / F_LO)) * r.w;
    g.circle(cx, yFor(biquadResponseDb(coefs, cutoff, sr)), 5)
      .fill(PORT_TYPE_COLORS.audio)
      .stroke({ width: 2, color: theme.text });
  }

  // -- controller faces (PRD §8.6) -------------------------------------------

  private ctrlG: Graphics | null = null;
  private ctrlText: Text | null = null;

  private setCtrl(paramId: string, v: number): void {
    appState.setParam(this.instance.id, paramId, Math.min(1, Math.max(0, v)));
  }

  /**
   * Display range for Knob/Slider modules (instance.data.cfg). Display-only:
   * the Control output always stays normalized 0–1.
   */
  private ctrlCfg(): { min: number; max: number; def: number } {
    const c = (this.instance.data?.cfg ?? {}) as Record<string, unknown>;
    const min = typeof c.min === 'number' && Number.isFinite(c.min) ? c.min : 0;
    let max = typeof c.max === 'number' && Number.isFinite(c.max) ? c.max : 1;
    if (max === min) max = min + 1;
    const def = typeof c.def === 'number' && Number.isFinite(c.def) ? c.def : min + 0.5 * (max - min);
    return { min, max, def: Math.min(max, Math.max(min, def)) };
  }

  /** The Knob/Slider value as a CtrlSpec in the configured display range. */
  private ctrlValueSpec(redraw: () => void): CtrlSpec {
    const cfg = this.ctrlCfg();
    return {
      key: 'value',
      label: this.instance.label ?? this.def.name,
      min: cfg.min,
      max: cfg.max,
      default: cfg.def,
      get: () => cfg.min + Math.min(1, Math.max(0, this.instance.params.value ?? 0)) * (cfg.max - cfg.min),
      set: (s) => {
        this.setCtrl('value', (s - cfg.min) / (cfg.max - cfg.min));
        redraw();
      },
      learnId: 'value',
    };
  }

  private ctrlScaledText(): string {
    const cfg = this.ctrlCfg();
    const v = cfg.min + Math.min(1, Math.max(0, this.instance.params.value ?? 0)) * (cfg.max - cfg.min);
    return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  }

  /** ⚙ opens the range-config popup (Knob/Slider modules). */
  private buildCtrlConfigButton(): void {
    const gear = new Text({ text: '⚙', style: { fontSize: 13, fill: theme.textDim } });
    gear.anchor.set(1, 0);
    gear.position.set(this.w - 6, TITLE_H + 4);
    gear.eventMode = 'static';
    gear.cursor = 'pointer';
    gear.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.openRangeConfig(this.instance.id);
    });
    gear.on('pointerover', (e) =>
      this.tooltip.show(['Range', 'Configure min, max and default. Display only — the output stays 0–1.'], e.clientX, e.clientY),
    );
    gear.on('pointerout', () => this.tooltip.hide());
    this.addChild(gear);
  }

  private knobCenter(): { cx: number; cy: number } {
    return { cx: this.w / 2, cy: TITLE_H + 56 };
  }

  private buildKnobFace(): void {
    const { cx, cy } = this.knobCenter();
    this.paramAnchors.set('value', { x: cx, y: cy });
    this.ctrlG = new Graphics();
    this.addChild(this.ctrlG);
    this.ctrlText = new Text({ text: '', style: { fontSize: 12, fill: theme.text } });
    this.ctrlText.anchor.set(0.5, 0);
    this.ctrlText.position.set(cx, cy + 44);
    this.addChild(this.ctrlText);
    this.drawKnob();
    this.buildCtrlConfigButton();

    const hit = new Graphics().circle(cx, cy, 40).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'ns-resize';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const c = this.ctrlValueSpec(() => this.drawKnob());
      if (this.ctrlPreamble(c, e)) return;
      appState.beginUndoable();
      const start = this.instance.params.value ?? 0;
      const startY = e.clientY;
      const scale = this.worldTransform.a || 1;
      const onMove = (ev: PointerEvent) => {
        this.setCtrl('value', start + (startY - ev.clientY) / scale / 120);
        this.drawKnob();
        this.tooltip.showNow([this.ctrlTipTitle(c)], ev.clientX, ev.clientY);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        this.tooltip.hide();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    hit.on('pointerover', (ev) => {
      const c = this.ctrlValueSpec(() => this.drawKnob());
      this.tooltip.show([this.ctrlTipTitle(c), `${CTRL_HINT} ⚙: range.`], ev.clientX, ev.clientY);
    });
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  drawKnob(): void {
    if (!this.ctrlG || this.instance.type !== 'knob') return;
    const { cx, cy } = this.knobCenter();
    const v = Math.min(1, Math.max(0, this.instance.params.value ?? 0));
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    const av = a0 + (a1 - a0) * v;
    const g = this.ctrlG;
    g.clear();
    g.circle(cx, cy, 28).fill(theme.inset).stroke({ width: 1, color: theme.moduleStroke });
    // moveTo before each arc: without it the path connects from its
    // current point (the graphics origin), drawing stray wire-like lines.
    g.moveTo(cx + Math.cos(a0) * 36, cy + Math.sin(a0) * 36);
    g.arc(cx, cy, 36, a0, a1).stroke({ width: 4, color: theme.inset });
    g.moveTo(cx + Math.cos(a0) * 36, cy + Math.sin(a0) * 36);
    g.arc(cx, cy, 36, a0, av).stroke({ width: 4, color: this.accent() });
    g.moveTo(cx + Math.cos(av) * 10, cy + Math.sin(av) * 10)
      .lineTo(cx + Math.cos(av) * 26, cy + Math.sin(av) * 26)
      .stroke({ width: 3, color: theme.text });
    if (this.ctrlText) this.ctrlText.text = this.ctrlScaledText();
  }

  private sliderTrack(): { x: number; y: number; w: number; h: number; horiz: boolean } {
    const horiz = Math.round(this.instance.params.orient ?? 0) === 1;
    const pad = 18;
    if (horiz) {
      return { x: pad, y: TITLE_H + 40, w: this.w - pad * 2, h: 12, horiz };
    }
    return { x: this.w / 2 - 6, y: TITLE_H + 14, w: 12, h: this.h - TITLE_H - 112, horiz };
  }

  private buildSliderFace(): void {
    this.ctrlG = new Graphics();
    this.addChild(this.ctrlG);
    this.ctrlText = new Text({ text: '', style: { fontSize: 12, fill: theme.text } });
    this.ctrlText.anchor.set(0.5, 0);
    this.ctrlText.position.set(this.w / 2, this.h - 90);
    this.addChild(this.ctrlText);
    this.drawSlider();
    this.buildCtrlConfigButton();
    const t0 = this.sliderTrack();
    this.paramAnchors.set('value', { x: t0.x + t0.w / 2, y: t0.y + t0.h / 2 });

    // Hit area covers both orientations; drawing follows the orient param.
    const hit = new Graphics()
      .rect(8, TITLE_H + 6, this.w - 16, this.h - TITLE_H - 98)
      .fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const c = this.ctrlValueSpec(() => this.drawSlider());
      if (this.ctrlPreamble(c, e)) return;
      const t = this.sliderTrack();
      appState.beginUndoable();
      // Jump to the click position, then track relatively.
      const local = this.toLocal(e.global);
      this.setCtrl('value', t.horiz ? (local.x - t.x) / t.w : 1 - (local.y - t.y) / t.h);
      this.drawSlider();
      const start = this.instance.params.value ?? 0;
      const startX = e.clientX;
      const startY = e.clientY;
      const scale = this.worldTransform.a || 1;
      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / scale;
        const dy = (ev.clientY - startY) / scale;
        this.setCtrl('value', start + (t.horiz ? dx / t.w : -dy / t.h));
        this.drawSlider();
        this.tooltip.showNow([this.ctrlTipTitle(c)], ev.clientX, ev.clientY);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        this.tooltip.hide();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    hit.on('pointerover', (ev) => {
      const c = this.ctrlValueSpec(() => this.drawSlider());
      this.tooltip.show([this.ctrlTipTitle(c), `${CTRL_HINT} ⚙: range.`], ev.clientX, ev.clientY);
    });
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);

    this.buildSelector(this.paramCtrl(this.paramSpec('orient')), this.w / 2, this.h - 42, 12);
  }

  drawSlider(): void {
    if (!this.ctrlG || this.instance.type !== 'slider') return;
    const v = Math.min(1, Math.max(0, this.instance.params.value ?? 0));
    const t = this.sliderTrack();
    const g = this.ctrlG;
    g.clear();
    g.roundRect(t.x, t.y, t.w, t.h, 5).fill(theme.inset).stroke({ width: 1, color: theme.moduleStroke });
    if (t.horiz) {
      g.roundRect(t.x, t.y, t.w * v, t.h, 5).fill(this.accent());
      g.roundRect(t.x + t.w * v - 7, t.y - 6, 14, t.h + 12, 4)
        .fill(theme.button)
        .stroke({ width: 1, color: theme.text });
    } else {
      g.roundRect(t.x, t.y + t.h * (1 - v), t.w, t.h * v, 5).fill(this.accent());
      g.roundRect(t.x - 12, t.y + t.h * (1 - v) - 7, t.w + 24, 14, 4)
        .fill(theme.button)
        .stroke({ width: 1, color: theme.text });
    }
    if (this.ctrlText) this.ctrlText.text = this.ctrlScaledText();
  }

  private xyPad(): { x: number; y: number; w: number; h: number } {
    return {
      x: 18,
      y: TITLE_H + 8,
      w: this.w - 36,
      h: this.h - TITLE_H - 8 - 58,
    };
  }

  private buildXyFace(): void {
    this.ctrlG = new Graphics();
    this.addChild(this.ctrlG);
    this.drawXy();

    const r = this.xyPad();
    this.paramAnchors.set('x', { x: r.x + r.w / 2, y: r.y + r.h / 2 });
    this.paramAnchors.set('y', { x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const hit = new Graphics().rect(r.x, r.y, r.w, r.h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'crosshair';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.beginUndoable();
      const local = this.toLocal(e.global);
      this.setCtrl('x', (local.x - r.x) / r.w);
      this.setCtrl('y', 1 - (local.y - r.y) / r.h);
      this.drawXy();
      const sx = this.instance.params.x ?? 0.5;
      const sy = this.instance.params.y ?? 0.5;
      const startX = e.clientX;
      const startY = e.clientY;
      const scale = this.worldTransform.a || 1;
      const onMove = (ev: PointerEvent) => {
        this.setCtrl('x', sx + (ev.clientX - startX) / scale / r.w);
        this.setCtrl('y', sy - (ev.clientY - startY) / scale / r.h);
        this.drawXy();
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (Math.round(this.instance.params.spring ?? 0) === 1) {
          this.setCtrl('x', 0.5);
          this.setCtrl('y', 0.5);
          this.drawXy();
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    hit.on('pointerover', (ev) =>
      this.tooltip.show(['XY pad: drag the puck. X and Y are separate control outputs.'], ev.clientX, ev.clientY),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);

    this.buildSelector(this.paramCtrl(this.paramSpec('spring')), this.w / 2, this.h - 32, 12);
  }

  drawXy(): void {
    if (!this.ctrlG || this.instance.type !== 'xy') return;
    const r = this.xyPad();
    const vx = Math.min(1, Math.max(0, this.instance.params.x ?? 0.5));
    const vy = Math.min(1, Math.max(0, this.instance.params.y ?? 0.5));
    const px = r.x + vx * r.w;
    const py = r.y + (1 - vy) * r.h;
    const g = this.ctrlG;
    g.clear();
    g.roundRect(r.x, r.y, r.w, r.h, 6).fill(theme.inset).stroke({ width: 1, color: theme.moduleStroke });
    g.moveTo(r.x + r.w / 2, r.y).lineTo(r.x + r.w / 2, r.y + r.h).stroke({ width: 1, color: theme.moduleStroke });
    g.moveTo(r.x, r.y + r.h / 2).lineTo(r.x + r.w, r.y + r.h / 2).stroke({ width: 1, color: theme.moduleStroke });
    g.moveTo(px, r.y).lineTo(px, r.y + r.h).stroke({ width: 1, color: theme.textDim, alpha: 0.4 });
    g.moveTo(r.x, py).lineTo(r.x + r.w, py).stroke({ width: 1, color: theme.textDim, alpha: 0.4 });
    g.circle(px, py, 9).fill(this.accent()).stroke({ width: 2, color: theme.text });
  }

  private buttonRect(): { x: number; y: number; w: number; h: number } {
    return { x: 22, y: TITLE_H + 10, w: this.w - 44, h: this.h - TITLE_H - 72 };
  }

  private buildButtonFace(): void {
    this.ctrlG = new Graphics();
    this.addChild(this.ctrlG);
    this.drawButton();

    const r = this.buttonRect();
    this.paramAnchors.set('value', { x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const hit = new Graphics().rect(r.x, r.y, r.w, r.h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    const release = () => {
      if (Math.round(this.instance.params.mode ?? 0) === 0 && (this.instance.params.value ?? 0) > 0.5) {
        this.setCtrl('value', 0);
        this.drawButton();
      }
    };
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      if (Math.round(this.instance.params.mode ?? 0) === 0) {
        // Momentary presses are transient — not worth an undo step.
        this.setCtrl('value', 1);
      } else {
        appState.beginUndoable();
        this.setCtrl('value', (this.instance.params.value ?? 0) > 0.5 ? 0 : 1);
      }
      this.drawButton();
    });
    hit.on('pointerup', release);
    hit.on('pointerupoutside', release);
    hit.on('pointerover', (ev) =>
      this.tooltip.show(['Button: hold (momentary) or click (toggle). Output is 0 or 1.'], ev.clientX, ev.clientY),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);

    this.buildSelector(this.paramCtrl(this.paramSpec('mode')), this.w / 2, this.h - 34, 12);
  }

  drawButton(): void {
    if (!this.ctrlG || this.instance.type !== 'button') return;
    const r = this.buttonRect();
    const on = (this.instance.params.value ?? 0) > 0.5;
    const g = this.ctrlG;
    g.clear();
    g.roundRect(r.x, r.y, r.w, r.h, 10)
      .fill(on ? this.accent() : theme.button)
      .stroke({ width: 2, color: on ? theme.text : theme.moduleStroke });
  }

  // -- Color Gen face: param grid + live preview + base/flash swatches -----------

  private colorPrevG: Graphics | null = null;
  private colorPrevRect = { x: 0, y: 0, w: 0, h: 0 };
  private lastPrevColor = -2;

  private buildColorGenFace(x: number, y: number, w: number): void {
    const ctrls = this.def.params.map((p) => this.paramCtrl(p));
    const band = this.ctrlBandH(ctrls.length, w);
    this.buildCtrlGrid(ctrls, x, y, w, band);

    // Live output strip, with the base/flash picker swatches on the right.
    const py = y + band + 8;
    const ph = Math.max(18, this.h - py - 14);
    this.colorPrevRect = { x, y: py, w: w - 60, h: ph };
    this.colorPrevG = new Graphics();
    this.addChild(this.colorPrevG);
    this.lastPrevColor = -2;

    const buildSwatch = (
      sx: number,
      tip: string[],
      get: () => number,
      apply: (h: number, s: number) => void,
    ) => {
      const g = new Graphics();
      const draw = () => {
        g.clear();
        g.roundRect(sx, py, 24, ph, 4).fill(get()).stroke({ width: 1, color: theme.moduleStroke });
      };
      draw();
      this.ctrlRedraws.push(draw);
      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.on('pointerdown', (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.type = 'color';
        input.value = rgbIntToHex(get());
        input.onchange = () => {
          const { h, s } = rgbIntToHsl(hexToRgbInt(input.value));
          appState.beginUndoable();
          apply(h, s);
          this.refreshParams();
        };
        input.click();
      });
      g.on('pointerover', (e) => this.tooltip.show(tip, e.clientX, e.clientY));
      g.on('pointerout', () => this.tooltip.hide());
      this.addChild(g);
    };

    buildSwatch(
      x + w - 52,
      ['Base color', 'Click to pick — writes the Hue/Sat params.'],
      () => hslToRgbInt(this.instance.params.hue ?? 0.6, this.instance.params.sat ?? 0.85, 0.5),
      (h, s) => {
        appState.setParam(this.instance.id, 'hue', h);
        appState.setParam(this.instance.id, 'sat', s);
      },
    );
    buildSwatch(
      x + w - 24,
      ['Flash color', 'Click to pick — writes the Flash Hue param (flash mode).'],
      () => hslToRgbInt(this.instance.params.hue2 ?? 0, this.instance.params.sat ?? 0.85, 0.5),
      (h) => appState.setParam(this.instance.id, 'hue2', h),
    );
  }

  // -- mixer face: channel faders + pan knobs ------------------------------------

  private buildMixerFace(x: number, y: number, w: number): void {
    const chW = w / 5;
    const panR = Math.max(11, Math.min(16, chW * 0.28));
    const faderH = this.h - y - panR * 2 - 64;
    const faderW = Math.max(10, Math.min(16, chW * 0.25));
    for (let ch = 1; ch <= 4; ch++) {
      const cx = x + (ch - 1) * chW + chW / 2;
      this.buildFader(this.paramCtrl(this.paramSpec(`lvl${ch}`)), cx - faderW / 2, y, faderW, faderH);
      this.buildKnob(this.paramCtrl(this.paramSpec(`pan${ch}`)), cx, y + faderH + panR + 30, panR);
    }
    const mx = x + 4 * chW + chW / 2;
    this.buildFader(this.paramCtrl(this.paramSpec('master')), mx - faderW / 2 - 1, y, faderW + 2, faderH);
  }

  // -- composer face (PRD §8.3, piano roll) --------------------------------------

  private compG: Graphics | null = null;
  private compRect = { x: 0, y: 0, w: 0, h: 0 };
  private lastCompPos = -1;
  private lastCompData: unknown = null;

  private buildComposerFace(x: number, y: number, w: number): void {
    const h = this.h - y - 12;
    this.compRect = { x, y, w, h };
    const bg = new Graphics().roundRect(x, y, w, h, 4).fill(0x0c0c12);
    bg.eventMode = 'static';
    bg.cursor = 'pointer';
    bg.on('pointertap', (e) => {
      e.stopPropagation();
      appState.openComposer(this.instance.id);
    });
    bg.on('pointerover', (e) =>
      this.tooltip.show(
        ['Composer clip', 'Click to open the piano-roll editor: notes, tools, MIDI import/export.'],
        e.clientX,
        e.clientY,
      ),
    );
    bg.on('pointerout', () => this.tooltip.hide());
    this.addChild(bg);
    this.compG = new Graphics();
    this.compG.eventMode = 'none';
    this.addChild(this.compG);

    this.drawCompPreview(-1);
  }

  private drawCompPreview(pos: number): void {
    if (!this.compG) return;
    const { x, y, w, h } = this.compRect;
    const clip = clipFromData(this.instance.data);
    const g = this.compG;
    g.clear();

    // Beat grid, light on bar lines.
    for (let b = 0; b <= clip.length; b++) {
      const gx = x + (b / clip.length) * w;
      g.moveTo(gx, y).lineTo(gx, y + h).stroke({
        width: 1,
        color: theme.moduleStroke,
        alpha: b % 4 === 0 ? 0.5 : 0.15,
      });
    }

    if (clip.notes.length) {
      let lo = 127;
      let hi = 0;
      for (const n of clip.notes) {
        lo = Math.min(lo, n.pitch);
        hi = Math.max(hi, n.pitch);
      }
      lo = Math.max(0, lo - 2);
      hi = Math.min(127, hi + 2);
      const rowH = h / (hi - lo + 1);
      for (const n of clip.notes) {
        const nx = x + (Math.min(n.start, clip.length) / clip.length) * w;
        const nw = Math.max(2, (Math.min(n.length, clip.length - n.start) / clip.length) * w);
        const ny = y + (hi - n.pitch) * rowH;
        g.roundRect(nx, ny + 1, nw, Math.max(2, rowH - 2), 1)
          .fill({ color: 0x3dd9ff, alpha: 0.35 + 0.65 * n.vel });
      }
    }

    if (pos >= 0) {
      const px = x + (pos / clip.length) * w;
      g.moveTo(px, y).lineTo(px, y + h).stroke({ width: 1.5, color: 0xffffff, alpha: 0.7 });
    }
  }

  // -- visualizer face (PRD §8.5) ----------------------------------------------

  private visG: Graphics | null = null;
  private visSprite: Sprite | null = null;
  private visTick = 0;
  private visRect = { x: 0, y: 0, w: 0, h: 0 };
  private visParticles: Array<{ x: number; y: number; vx: number; vy: number; life: number; hue: number }> = [];

  private buildVisFace(x: number, y: number, w: number): void {
    const h = this.h - y - 12;
    this.visRect = { x, y, w, h };
    const bg = new Graphics().roundRect(x, y, w, h, 4).fill(0x0c0c12);
    // Double-click anywhere on the scene opens the graph editor.
    bg.eventMode = 'static';
    bg.cursor = 'pointer';
    bg.on('pointertap', (e) => {
      if (e.detail === 2) {
        e.stopPropagation();
        appState.openVisEditor(this.instance.id);
      }
    });
    bg.on('pointerover', (e) =>
      this.tooltip.show(['Visualizer scene', 'Double-click to edit the visual graph.'], e.clientX, e.clientY),
    );
    bg.on('pointerout', () => this.tooltip.hide());
    this.addChild(bg);
    if (webgpuAvailable()) {
      // Live GPU thumbnail of the real graph (¼ rate); Graphics stays as a
      // fallback layer while the renderer spins up or when it fails.
      this.visSprite = new Sprite(visThumb(this.instance.id, h / w).texture);
      this.visSprite.position.set(x, y);
      this.visSprite.setSize(w, h);
      this.visSprite.eventMode = 'none';
      this.addChild(this.visSprite);
    }
    this.visG = new Graphics();
    this.visG.eventMode = 'none';
    this.addChild(this.visG);

    const big = new Text({ text: '⛶', style: { fontSize: 14, fill: theme.textDim } });
    big.anchor.set(1, 0);
    big.position.set(x + w - 4, y + 4);
    big.eventMode = 'static';
    big.cursor = 'pointer';
    big.hitArea = new Rectangle(-20, -4, 26, 26);
    big.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.openVisualizer(this.instance.id);
    });
    big.on('pointerover', (e) =>
      this.tooltip.show(['Big view', 'Opens the resizable visualizer window (fullscreen button inside).'], e.clientX, e.clientY),
    );
    big.on('pointerout', () => this.tooltip.hide());
    this.addChild(big);

    const edit = new Text({ text: '✎', style: { fontSize: 14, fill: theme.textDim } });
    edit.anchor.set(1, 0);
    edit.position.set(x + w - 28, y + 4);
    edit.eventMode = 'static';
    edit.cursor = 'pointer';
    edit.hitArea = new Rectangle(-20, -4, 26, 26);
    edit.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.openVisEditor(this.instance.id);
    });
    edit.on('pointerover', (e) =>
      this.tooltip.show(['Edit visuals', 'Opens the visual graph editor (sources, effects, wiring).'], e.clientX, e.clientY),
    );
    edit.on('pointerout', () => this.tooltip.hide());
    this.addChild(edit);
  }

  /** Cheap screen-bounds test for thumbnail culling (stage is in screen px). */
  private tileOnScreen(): boolean {
    const gp = this.getGlobalPosition();
    const s = this.worldTransform.a;
    return (
      gp.x + this.w * s > 0 &&
      gp.x < window.innerWidth &&
      gp.y + this.h * s > 0 &&
      gp.y < window.innerHeight
    );
  }

  /**
   * Tile thumbnail — Canvas2D-equivalent approximation of the container's
   * visual graph (first source node wins), driven by the UI-side feature hub.
   * The overlay's no-WebGPU tier draws the same scenes on a 2D canvas.
   */
  private drawVisScene(): void {
    if (!this.visG) return;
    if (this.visSprite) {
      const thumb = visThumb(this.instance.id, this.visRect.h / Math.max(1, this.visRect.w));
      if (thumb.renderer) {
        this.visG.clear();
        this.visSprite.visible = true;
        // ¼ rate, and culled entirely while the tile is off screen.
        if ((this.visTick++ & 3) === 0 && this.tileOnScreen()) {
          const frame = appState.visFrame(this.instance.id);
          if (frame && graphSupported(frame.graph)) {
            thumb.renderer.render(frame);
            thumb.texture.source.update();
          }
        }
        return;
      }
      this.visSprite.visible = false;
      if (!thumb.failed) {
        // Renderer still initializing — draw the approximation meanwhile.
      }
    }
    const f = appState.visFeatures(this.instance.id);
    const { x, y, w, h } = this.visRect;
    const g = this.visG;
    const { scene, gain: baseGain } = approximateScene(visGraphOf(this.instance.data));
    const ctrl = f && f.ctrl >= 0 ? f.ctrl : 1;
    const gain = baseGain * (0.3 + 0.7 * ctrl);
    g.clear();
    if (!f) return;

    if (scene === 'scope') {
      // Oscilloscope — 256 points sampled from the 1024-sample window.
      const mid = y + h / 2;
      const step = f.wave.length / 256;
      for (let i = 0; i < 256; i++) {
        const v = f.wave[Math.floor(i * step)];
        const px = x + (i / 255) * w;
        const py = mid - Math.max(-1, Math.min(1, v * gain)) * (h / 2 - 4);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke({ width: 1.5, color: 0x3dd9ff, alpha: 0.95 });
    } else if (scene === 'spectrum') {
      // Spectrum bars.
      const n = f.spectrum.length;
      const bw = w / n;
      for (let b = 0; b < n; b++) {
        const frac = binFrac(f.spectrum[b]) * Math.min(1, gain);
        if (frac <= 0.01) continue;
        g.roundRect(x + b * bw + 1, y + h - frac * (h - 6), bw - 2, frac * (h - 6), 1)
          .fill({ color: 0xffb13d, alpha: 0.9 });
      }
    } else {
      // Particles: notes spawn bursts, audio energy feeds drift speed.
      let energy = 0;
      for (const db of f.spectrum) energy = Math.max(energy, binFrac(db));
      for (const pitch of f.notes) {
        const hue = ((pitch % 12) / 12) * 360;
        for (let i = 0; i < 6; i++) {
          this.visParticles.push({
            x: x + w * ((pitch % 36) / 36),
            y: y + h * 0.7,
            vx: (Math.random() - 0.5) * 3,
            vy: -1 - Math.random() * 2.5,
            life: 1,
            hue,
          });
        }
      }
      if (this.visParticles.length > 200) this.visParticles.splice(0, this.visParticles.length - 200);
      const speed = 0.5 + energy * 2 * gain;
      this.visParticles = this.visParticles.filter((p) => {
        p.x += p.vx * speed;
        p.y += p.vy * speed;
        p.vy += 0.04;
        p.life -= 0.02;
        if (p.life <= 0 || p.x < x || p.x > x + w || p.y > y + h) return false;
        const c = hslToHex(p.hue, 0.8, 0.6);
        g.circle(p.x, p.y, 1.5 + p.life * 2.5).fill({ color: c, alpha: p.life });
        return true;
      });
    }
  }

  // -- text producer faces (stt/textinput/transporttext/notenames) --------------

  private textFaceLine: Text | null = null;
  private textFaceStatus: Text | null = null;

  private buildTextFace(x: number, y: number, w: number): void {
    const h = this.h - y - 12;
    const bg = new Graphics().roundRect(x, y, w, h, 4).fill(0x0c0c12);
    this.addChild(bg);

    this.textFaceStatus = new Text({ text: '', style: { fontSize: 10, fill: theme.textDim } });
    this.textFaceStatus.position.set(x + 8, y + 6);
    this.addChild(this.textFaceStatus);

    this.textFaceLine = new Text({
      text: '',
      style: { fontSize: 13, fill: 0xe8e8ee, wordWrap: true, wordWrapWidth: w - 16 },
    });
    this.textFaceLine.position.set(x + 8, y + 24);
    this.addChild(this.textFaceLine);
    this.updateTextFace();

    const type = this.instance.type;
    if (type === 'stt' || type === 'textinput') {
      bg.eventMode = 'static';
      bg.cursor = 'pointer';
      bg.on('pointerdown', (e) => {
        e.stopPropagation();
        if (type === 'stt') {
          const on = appState.toggleStt(this.instance.id);
          if (!on && !appState.stt.supported()) {
            this.tooltip.show(['Speech to Text', 'Speech recognition is not available in this browser.'], e.clientX, e.clientY);
          }
        } else {
          const last = (this.instance.data?.lastText as string) ?? '';
          const text = window.prompt('Text to send', last);
          if (text !== null && text !== '') appState.sendTextInput(this.instance.id, text);
        }
        this.updateTextFace();
      });
      bg.on('pointerover', (e) =>
        this.tooltip.show(
          type === 'stt'
            ? ['Speech to Text', 'Click to start/stop listening (mic permission).']
            : ['Text Input', 'Click to type a line; it is sent on OK.'],
          e.clientX,
          e.clientY,
        ),
      );
      bg.on('pointerout', () => this.tooltip.hide());
    }
  }

  /** Per-frame: mirror the module's live text output onto the face. */
  private updateTextFace(): void {
    if (!this.textFaceLine || !this.textFaceStatus) return;
    const type = this.instance.type;
    const ev = appState.textValues[this.instance.id];
    let line = ev?.text ?? '';
    if (!line && type === 'textinput') line = (this.instance.data?.lastText as string) ?? '';
    this.textFaceLine.text = line || '—';
    this.textFaceLine.alpha = ev && !ev.final ? 0.6 : 1;
    this.textFaceStatus.text =
      type === 'stt'
        ? appState.stt.active(this.instance.id)
          ? '🎤 listening — click to stop'
          : appState.stt.supported()
            ? '🎤 click to listen'
            : 'speech recognition unavailable'
        : type === 'textinput'
          ? 'click to type'
          : type === 'transporttext'
            ? 'transport readout'
            : 'last notes';
  }

  // -- MIDI device row (midiIn/midiOut) ----------------------------------------

  private midiDeviceText: Text | null = null;

  private buildMidiDeviceRow(x: number, y: number, w: number): void {
    this.midiDeviceText = new Text({ text: '', style: { fontSize: 10, fill: theme.textDim } });
    this.midiDeviceText.position.set(x, y);
    this.addChild(this.midiDeviceText);
    this.updateMidiDeviceText();

    const hit = new Graphics().rect(x - 4, y - 4, w + 8, 18).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      void appState.midi.init().then(() => {
        const isIn = this.instance.type === 'midiIn';
        const fallback = isIn ? 'all inputs' : 'first output';
        const devices = [
          { id: '', name: fallback },
          ...(isIn ? appState.midi.inputs() : appState.midi.outputs()),
        ];
        const current = (this.instance.data?.deviceId as string) || '';
        const idx = devices.findIndex((d) => d.id === current);
        const next = devices[(idx + 1) % devices.length];
        appState.setModuleData(this.instance.id, 'deviceId', next.id);
        appState.setModuleData(this.instance.id, 'deviceName', next.name);
        this.updateMidiDeviceText();
      });
    });
    hit.on('pointerover', (e) =>
      this.tooltip.show(
        ['MIDI device', appState.midi.supported ? 'Click to cycle through available ports.' : 'WebMIDI not supported in this browser.'],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  private updateMidiDeviceText(): void {
    if (!this.midiDeviceText) return;
    const name = (this.instance.data?.deviceName as string) || 'default';
    this.midiDeviceText.text = `dev: ${name}`;
  }

  // -- parametric EQ face (PRD §8.4: curve + dots + live spectrum) -------------

  private static readonly PEQ_COLORS = [0xff5050, 0xffb13d, 0x52e07a, 0x3dd9ff, 0xb070ff, 0xff3dd0];

  private peqPlot: Graphics | null = null;
  private peqSpectrumG: Graphics | null = null;
  private peqDots: Graphics[] = [];
  private peqRect = { x: 0, y: 0, w: 0, h: 0 };
  private lastSpectrum: number[] | null = null;

  private peqFreqToX(f: number): number {
    const { x, w } = this.peqRect;
    return x + (Math.log10(Math.max(20, f) / 20) / 3) * w;
  }

  private peqGainToY(db: number): number {
    const { y, h } = this.peqRect;
    return y + h / 2 - (db / 18) * (h / 2);
  }

  private buildPeqFace(x: number, y: number, w: number): void {
    const h = this.h - y - 14;
    this.peqRect = { x, y, w, h };

    const bg = new Graphics().roundRect(x, y, w, h, 4).fill(theme.inset);
    this.addChild(bg);
    this.peqSpectrumG = new Graphics();
    this.addChild(this.peqSpectrumG);
    this.peqPlot = new Graphics();
    this.peqPlot.eventMode = 'none';
    this.addChild(this.peqPlot);

    for (let n = 1; n <= 6; n++) {
      const dot = new Graphics();
      dot.circle(0, 0, 6).fill(ModuleView.PEQ_COLORS[n - 1]).stroke({ width: 1.5, color: 0x16161c });
      dot.eventMode = 'static';
      dot.cursor = 'move';
      dot.hitArea = { contains: (px: number, py: number) => px * px + py * py < 14 * 14 };
      dot.on('pointerdown', (e) => {
        e.stopPropagation();
        this.beginPeqBandDrag(n, e);
      });
      dot.on('pointerover', (e) => {
        const p = this.instance.params;
        this.tooltip.show(
          [`Band ${n}: ${this.peqBandLabel(n)}`,
            `${Math.round(p[`b${n}freq`])} Hz, ${p[`b${n}gain`].toFixed(1)} dB, Q ${p[`b${n}q`].toFixed(2)}. Drag: freq/gain. Shift-drag: Q. Click: type.`],
          e.clientX,
          e.clientY,
        );
      });
      dot.on('pointerout', () => this.tooltip.hide());
      this.addChild(dot);
      this.peqDots.push(dot);
    }
    this.drawPeqCurve();
  }

  private peqBandLabel(n: number): string {
    const types = ['peak', 'lo-shelf', 'hi-shelf', 'lo-cut', 'hi-cut'];
    return types[Math.round(this.instance.params[`b${n}type`] ?? 0)] ?? 'peak';
  }

  private beginPeqBandDrag(n: number, e: FederatedPointerEvent): void {
    appState.beginUndoable();
    const startX = e.clientX;
    const startY = e.clientY;
    const p = this.instance.params;
    const startFreq = p[`b${n}freq`] ?? 1000;
    const startGain = p[`b${n}gain`] ?? 0;
    const startQ = p[`b${n}q`] ?? 0.9;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      if (ev.shiftKey) {
        const q = Math.min(8, Math.max(0.3, startQ * Math.pow(2, -dy / 60)));
        appState.setParam(this.instance.id, `b${n}q`, q);
        this.tooltip.showNow([`Q ${q.toFixed(2)}`], ev.clientX, ev.clientY);
      } else {
        const freq = Math.min(20000, Math.max(20, startFreq * Math.pow(10, (dx / this.peqRect.w) * 3)));
        const gain = Math.min(18, Math.max(-18, startGain - (dy / (this.peqRect.h / 2)) * 18));
        appState.setParam(this.instance.id, `b${n}freq`, freq);
        appState.setParam(this.instance.id, `b${n}gain`, gain);
        this.tooltip.showNow([`${Math.round(freq)} Hz  ${gain.toFixed(1)} dB`], ev.clientX, ev.clientY);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.tooltip.hide();
      if (!moved) {
        const next = (Math.round(this.instance.params[`b${n}type`] ?? 0) + 1) % 5;
        appState.setParam(this.instance.id, `b${n}type`, next);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** Grid + combined response curve + dot positions. Called on param changes. */
  private drawPeqCurve(): void {
    if (!this.peqPlot) return;
    const { x, y, w, h } = this.peqRect;
    const g = this.peqPlot;
    const sr = appState.engine.sampleRate;
    g.clear();

    for (const f of [100, 1000, 10000]) {
      const gx = this.peqFreqToX(f);
      g.moveTo(gx, y).lineTo(gx, y + h);
    }
    g.moveTo(x, y + h / 2).lineTo(x + w, y + h / 2);
    g.stroke({ width: 1, color: 0xffffff, alpha: 0.08 });

    const p = this.instance.params;
    const bands = [];
    for (let n = 1; n <= 6; n++) {
      bands.push(
        bandCoefs(
          Math.round(p[`b${n}type`] ?? 0) as 0 | 1 | 2 | 3 | 4,
          p[`b${n}freq`] ?? 1000,
          p[`b${n}gain`] ?? 0,
          p[`b${n}q`] ?? 0.9,
          sr,
        ),
      );
    }
    let first = true;
    for (let px = 0; px <= w; px += 3) {
      const f = 20 * Math.pow(10, (3 * px) / w);
      const db = Math.min(18, Math.max(-18, chainResponseDb(bands, f, sr)));
      const gy = this.peqGainToY(db);
      if (first) {
        g.moveTo(x + px, gy);
        first = false;
      } else {
        g.lineTo(x + px, gy);
      }
    }
    g.stroke({ width: 2, color: 0xffb13d, alpha: 0.95 });

    this.peqDots.forEach((dot, i) => {
      const n = i + 1;
      dot.position.set(
        this.peqFreqToX(p[`b${n}freq`] ?? 1000),
        this.peqGainToY(Math.min(18, Math.max(-18, p[`b${n}gain`] ?? 0))),
      );
    });
  }

  private drawPeqSpectrum(spectrum: number[]): void {
    if (!this.peqSpectrumG) return;
    const { x, y, w, h } = this.peqRect;
    const g = this.peqSpectrumG;
    g.clear();
    g.moveTo(x, y + h);
    spectrum.forEach((db, b) => {
      const frac = Math.min(1, Math.max(0, (db + 80) / 80));
      g.lineTo(x + ((b + 0.5) / spectrum.length) * w, y + h - frac * h);
    });
    g.lineTo(x + w, y + h);
    g.closePath();
    g.fill({ color: 0x3dd9ff, alpha: 0.16 });
  }

  // -- gain-reduction meter (compressor/limiter/mbcomp): vertical red bar -------

  private grBar: Graphics | null = null;
  private grRect = { x: 0, y: 0, w: 0, h: 0 };

  private buildGrMeter(x: number, y: number, w: number, h: number): void {
    const label = new Text({ text: 'GR', style: { fontSize: 9, fill: theme.textDim } });
    label.anchor.set(0.5, 1);
    label.position.set(x + w / 2, y - 2);
    this.addChild(label);
    const bg = new Graphics().roundRect(x, y, w, h, 3).fill(theme.inset);
    this.addChild(bg);
    this.grBar = new Graphics();
    this.addChild(this.grBar);
    this.grRect = { x, y, w, h };
  }

  // -- drum machine face -----------------------------------------------------


  // -- synth wavetable loader --------------------------------------------------

  private wtRowText: Text | null = null;

  private buildWavetableRow(x: number, y: number, w: number): void {
    this.wtRowText = new Text({ text: '', style: { fontSize: 10, fill: theme.textDim } });
    this.wtRowText.position.set(x, y);
    this.addChild(this.wtRowText);
    this.updateWtRowText();

    const hit = new Graphics().rect(x - 4, y - 4, w + 8, 18).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void appState.loadSampleFile(this.instance.id, file);
      };
      input.click();
    });
    hit.on('pointerover', (e) =>
      this.tooltip.show(
        ['Wavetable', 'Click to load a wavetable file (2048-sample frames; short files become one cycle).'],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  private updateWtRowText(): void {
    if (!this.wtRowText) return;
    const name = (this.instance.data?.sampleName as string) || '';
    this.wtRowText.text = name ? `WT: ${name}` : 'WT: built-in table — click to load';
  }

  // -- recorder face -----------------------------------------------------------

  private recButton: Graphics | null = null;
  private recLabel: Text | null = null;
  private recElapsed: Text | null = null;
  private recRect = { x: 0, y: 0 };

  private buildRecorderFace(x: number, y: number, w: number): void {
    this.recRect = { x, y };
    this.recButton = new Graphics();
    this.addChild(this.recButton);

    this.recLabel = new Text({ text: '', style: { fontSize: 12, fill: theme.text, fontWeight: 'bold' } });
    this.recLabel.anchor.set(0.5);
    this.recLabel.position.set(x + 45, y + 15);
    this.recLabel.eventMode = 'none';
    this.addChild(this.recLabel);

    this.recElapsed = new Text({ text: '0.0 s', style: { fontSize: 12, fill: theme.textDim } });
    this.recElapsed.anchor.set(0, 0);
    this.recElapsed.position.set(x, y + 38);
    this.addChild(this.recElapsed);

    const hit = new Graphics().rect(x, y, 90, 30).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.toggleRecord(this.instance.id);
      this.drawRecButton();
    });
    hit.on('pointerover', (e) =>
      this.tooltip.show(
        ['Recorder', 'Records incoming audio; stopping downloads a WAV file.'],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
    this.drawRecButton();
  }

  private drawRecButton(): void {
    if (!this.recButton || !this.recLabel) return;
    const recording = appState.isRecording(this.instance.id);
    const { x, y } = this.recRect;
    this.recButton
      .clear()
      .roundRect(x, y, 90, 30, 6)
      .fill(recording ? 0xaa2020 : theme.button)
      .stroke({ width: 1, color: recording ? 0xff5050 : 0x4a4a58 });
    this.recLabel.text = recording ? '■ STOP' : '● REC';
  }

  // -- sampler face ----------------------------------------------------------

  private waveform: Graphics | null = null;
  private sampleNameText: Text | null = null;
  private waveRect = { x: 0, y: 0, w: 0, h: 0 };

  private buildSamplerFace(x: number, y: number, w: number): void {
    const h = Math.max(40, this.h - y - 28);
    this.waveRect = { x, y, w, h };
    this.waveform = new Graphics();
    this.addChild(this.waveform);

    this.sampleNameText = new Text({
      text: '',
      style: { fontSize: 10, fill: theme.textDim },
    });
    this.sampleNameText.position.set(x, y + h + 6);
    // Loaded sample's name opens the Sample Editor (PRD §8.2).
    this.sampleNameText.eventMode = 'static';
    this.sampleNameText.cursor = 'pointer';
    this.sampleNameText.on('pointerdown', (e) => {
      if (!appState.samples.has(this.instance.id)) return; // falls through to file load
      e.stopPropagation();
      appState.openSampleEditor(this.instance.id);
    });
    this.sampleNameText.on('pointerover', (e) => {
      if (appState.samples.has(this.instance.id)) {
        this.tooltip.show(['Sample Editor', 'Click to edit: trim, normalize, loop points…'], e.clientX, e.clientY);
      }
    });
    this.sampleNameText.on('pointerout', () => this.tooltip.hide());
    this.addChild(this.sampleNameText);

    const hit = new Graphics().rect(x, y, w, h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void appState.loadSampleFile(this.instance.id, file);
      };
      input.click();
    });
    hit.on('pointerover', (e) =>
      this.tooltip.show(
        ['Sample', appState.samples.has(this.instance.id) ? 'Click to load a different file.' : 'Click to load an audio file.'],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
    this.refreshSample();
  }

  refreshSample(): void {
    this.updateWtRowText();
    if (!this.waveform) return;
    const { x, y, w, h } = this.waveRect;
    const g = this.waveform;
    g.clear();
    g.roundRect(x, y, w, h, 4).fill(theme.inset);
    const sample = appState.samples.get(this.instance.id);
    if (this.sampleNameText) {
      this.sampleNameText.text = sample
        ? sample.name
        : 'no sample — click waveform area to load';
    }
    if (!sample) return;
    const pcm = sample.channels[0];
    const mid = y + h / 2;
    const cols = Math.floor(w) - 8;
    const step = pcm.length / cols;
    for (let c = 0; c < cols; c++) {
      let min = 1;
      let max = -1;
      const start = Math.floor(c * step);
      const end = Math.min(pcm.length, Math.ceil((c + 1) * step));
      // Sparse scan keeps long samples cheap; thumbnails don't need exactness.
      const stride = Math.max(1, Math.floor((end - start) / 16));
      for (let i = start; i < end; i += stride) {
        const v = pcm[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max < min) continue;
      const x0 = x + 4 + c;
      g.moveTo(x0, mid + min * (h / 2 - 3));
      g.lineTo(x0, mid + max * (h / 2 - 3));
    }
    g.stroke({ width: 1, color: 0xffb13d, alpha: 0.9 });
  }

  // -- sequencer step grid ---------------------------------------------------

  private stepGrid: Graphics | null = null;
  private stepGridRect = { x: 0, y: 0, w: 0, h: 0 };
  private lastDrawnStep = -1;

  private steps(): SeqStep[] {
    return (this.instance.data?.steps as SeqStep[]) ?? [];
  }

  /** Rows visible in the pitch grid (one octave). */
  private static readonly SEQ_GRID_ROWS = 12;

  /** Lowest pitch of the visible grid window — stored, else fit to pattern. */
  private seqGridLo(): number {
    const maxLo = SEQ_PITCH_MAX - ModuleView.SEQ_GRID_ROWS + 1;
    const stored = Number(this.instance.data?.gridLo);
    if (Number.isFinite(stored) && stored > 0) {
      return Math.min(maxLo, Math.max(SEQ_PITCH_MIN, Math.round(stored)));
    }
    const on = this.steps().filter((s) => s.on).map((s) => s.pitch);
    const lo = on.length ? Math.min(...on) : 57;
    return Math.min(maxLo, Math.max(SEQ_PITCH_MIN, lo));
  }

  private buildStepGrid(x: number, y: number, w: number): void {
    const h = Math.max(30, this.h - y - 12);
    const gridW = w - 16; // room for the pitch-window shift buttons
    this.stepGridRect = { x, y, w: gridW, h };
    this.stepGrid = new Graphics();
    this.addChild(this.stepGrid);
    this.drawStepGrid();

    const hit = new Graphics().rect(x, y, gridW, h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      this.beginStepEdit(e);
    });
    hit.on('pointerover', (e) =>
      this.tooltip.show(
        ['Steps', 'Rows are pitches. Click a tile to set it, click again to clear; drag to paint. ▲▼ shift the octave window.'],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);

    // Pitch-window shift buttons (right edge).
    const shift = (glyph: string, by: number, ty: number) => {
      const t = new Text({ text: glyph, style: { fontSize: 10, fill: theme.textDim } });
      t.anchor.set(0.5, 0.5);
      t.position.set(x + w - 7, ty);
      t.eventMode = 'static';
      t.cursor = 'pointer';
      t.hitArea = { contains: (px, py) => Math.abs(px) < 10 && Math.abs(py) < 12 };
      t.on('pointerdown', (e) => {
        e.stopPropagation();
        const maxLo = SEQ_PITCH_MAX - ModuleView.SEQ_GRID_ROWS + 1;
        const next = Math.min(maxLo, Math.max(SEQ_PITCH_MIN, this.seqGridLo() + by));
        appState.setModuleData(this.instance.id, 'gridLo', next);
        this.drawStepGrid(this.lastDrawnStep);
      });
      t.on('pointerover', (e) =>
        this.tooltip.show([`Shift pitch window ${by > 0 ? 'up' : 'down'}`], e.clientX, e.clientY),
      );
      t.on('pointerout', () => this.tooltip.hide());
      this.addChild(t);
    };
    shift('▲', 1, y + 8);
    shift('▼', -1, y + h - 8);
  }

  private stepIndexAt(localX: number): number {
    const { x, w } = this.stepGridRect;
    const steps = this.steps();
    return Math.min(steps.length - 1, Math.max(0, Math.floor(((localX - x) / w) * steps.length)));
  }

  /** Pitch of the grid row under a tile-local y (rows top→bottom = high→low). */
  private stepPitchAt(localY: number): number {
    const { y, h } = this.stepGridRect;
    const rows = ModuleView.SEQ_GRID_ROWS;
    const row = Math.min(rows - 1, Math.max(0, Math.floor(((localY - y) / h) * rows)));
    return this.seqGridLo() + (rows - 1 - row);
  }

  private beginStepEdit(e: FederatedPointerEvent): void {
    appState.beginUndoable();
    const steps = this.steps();
    const first = this.toLocal(e.global);
    const firstIdx = this.stepIndexAt(first.x);
    const firstPitch = this.stepPitchAt(first.y);
    const firstStep = steps[firstIdx];
    if (!firstStep) return;
    // Clicking a step's lit tile erases; anything else paints (and dragging
    // continues in the same mode, painting/erasing every tile crossed).
    const erase = firstStep.on && firstStep.pitch === firstPitch;

    const commit = () => {
      appState.setModuleData(this.instance.id, 'steps', [...steps]);
      this.drawStepGrid(this.lastDrawnStep);
    };
    const apply = (localX: number, localY: number, clientX: number, clientY: number) => {
      const idx = this.stepIndexAt(localX);
      const pitch = this.stepPitchAt(localY);
      const step = steps[idx];
      if (!step) return;
      if (erase) {
        step.on = false;
      } else {
        step.on = true;
        step.pitch = pitch;
        this.tooltip.showNow([noteName(pitch)], clientX, clientY);
      }
      commit();
    };
    apply(first.x, first.y, e.clientX, e.clientY);

    const scale = this.worldTransform.a || 1;
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: PointerEvent) => {
      apply(
        first.x + (ev.clientX - sx) / scale,
        first.y + (ev.clientY - sy) / scale,
        ev.clientX,
        ev.clientY,
      );
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.tooltip.hide();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private drawStepGrid(playhead = -1): void {
    if (!this.stepGrid) return;
    const { x, y, w, h } = this.stepGridRect;
    const steps = this.steps();
    if (steps.length === 0) return;
    const rows = ModuleView.SEQ_GRID_ROWS;
    const lo = this.seqGridLo();
    const hi = lo + rows - 1;
    const cellW = w / steps.length;
    const cellH = h / rows;
    const g = this.stepGrid;
    g.clear();
    for (let i = 0; i < steps.length; i++) {
      const cx = x + i * cellW;
      const step = steps[i];
      for (let r = 0; r < rows; r++) {
        const pitch = lo + (rows - 1 - r);
        const cy = y + r * cellH;
        const isC = pitch % 12 === 0;
        g.roundRect(cx + 1, cy + 0.5, cellW - 2, cellH - 1, 2)
          .fill({ color: theme.inset, alpha: isC ? 0.6 : 1 });
        if (step.on && step.pitch === pitch) {
          g.roundRect(cx + 1.5, cy + 1, cellW - 3, cellH - 2, 2)
            .fill(i === playhead ? 0x7fe9ff : 0x3dd9ff);
        }
      }
      // Active step outside the visible window: edge marker.
      if (step.on && step.pitch > hi) {
        g.moveTo(cx + cellW / 2 - 3, y + 6).lineTo(cx + cellW / 2 + 3, y + 6)
          .lineTo(cx + cellW / 2, y + 1).closePath().fill(0x3dd9ff);
      } else if (step.on && step.pitch < lo) {
        g.moveTo(cx + cellW / 2 - 3, y + h - 6).lineTo(cx + cellW / 2 + 3, y + h - 6)
          .lineTo(cx + cellW / 2, y + h - 1).closePath().fill(0x3dd9ff);
      }
      if (i === playhead) {
        g.roundRect(cx + 1, y, cellW - 2, h, 2).fill({ color: 0xffffff, alpha: 0.12 });
      }
    }
  }

  // -- modulation matrix face -------------------------------------------------

  private matrixG: Graphics | null = null;
  private matrixRect = { x: 0, y: 0, w: 0, h: 0 };

  /** 4×4 depth grid: rows = control inputs, columns = control outputs. */
  private buildModMatrixFace(x: number, y: number, w: number): void {
    const labelW = 30;
    const labelH = 14;
    const gx = x + labelW;
    const gy = y + labelH;
    const gw = w - labelW;
    const gh = Math.max(60, this.h - gy - 14);
    this.matrixRect = { x: gx, y: gy, w: gw, h: gh };

    const n = MODMATRIX_SIZE;
    for (let j = 0; j < n; j++) {
      const t = new Text({ text: `→${j + 1}`, style: { fontSize: 9, fill: theme.textDim } });
      t.anchor.set(0.5, 0);
      t.position.set(gx + (j + 0.5) * (gw / n), y);
      t.eventMode = 'none';
      this.addChild(t);
    }
    for (let i = 0; i < n; i++) {
      const t = new Text({ text: `${i + 1}`, style: { fontSize: 9, fill: theme.textDim } });
      t.anchor.set(1, 0.5);
      t.position.set(gx - 6, gy + (i + 0.5) * (gh / n));
      t.eventMode = 'none';
      this.addChild(t);
    }

    this.matrixG = new Graphics();
    this.addChild(this.matrixG);
    this.drawModMatrix();

    const hit = new Graphics().rect(gx, gy, gw, gh).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'ns-resize';
    let lastTap = { cell: '', at: 0 };
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const local = this.toLocal(e.global);
      const i = Math.min(n - 1, Math.max(0, Math.floor(((local.y - gy) / gh) * n)));
      const j = Math.min(n - 1, Math.max(0, Math.floor(((local.x - gx) / gw) * n)));
      const paramId = `m${i + 1}${j + 1}`;
      // Double-click zeroes the crossing.
      const now = performance.now();
      if (lastTap.cell === paramId && now - lastTap.at < 350) {
        appState.beginUndoable();
        appState.setParam(this.instance.id, paramId, 0);
        this.drawModMatrix();
        return;
      }
      lastTap = { cell: paramId, at: now };

      appState.beginUndoable();
      const start = this.instance.params[paramId] ?? 0;
      const sy = e.clientY;
      const onMove = (ev: PointerEvent) => {
        const v = Math.min(1, Math.max(-1, start + (sy - ev.clientY) / 80));
        appState.setParam(this.instance.id, paramId, v);
        this.tooltip.showNow([`${i + 1}→${j + 1}: ${v.toFixed(2)}`], ev.clientX, ev.clientY);
        this.drawModMatrix();
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        this.tooltip.hide();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    hit.on('pointerover', (e) =>
      this.tooltip.show(
        ['Mod matrix', 'Rows: inputs. Columns: outputs. Drag a cell up/down to set depth (±1); double-click zeroes it.'],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  private drawModMatrix(): void {
    if (!this.matrixG) return;
    const { x, y, w, h } = this.matrixRect;
    const n = MODMATRIX_SIZE;
    const cw = w / n;
    const ch = h / n;
    const g = this.matrixG;
    g.clear();
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const cx = x + j * cw;
        const cy = y + i * ch;
        const amt = this.instance.params[`m${i + 1}${j + 1}`] ?? 0;
        g.roundRect(cx + 1, cy + 1, cw - 2, ch - 2, 3).fill(theme.inset);
        if (Math.abs(amt) > 0.005) {
          // Bar grows from the cell's vertical center: up = +, down = −.
          const mid = cy + ch / 2;
          const barH = (Math.abs(amt) * (ch - 6)) / 2;
          g.roundRect(
            cx + 3,
            amt > 0 ? mid - barH : mid,
            cw - 6,
            barH,
            2,
          ).fill(amt > 0 ? PORT_TYPE_COLORS.control : 0x52e07a);
        } else {
          g.circle(cx + cw / 2, cy + ch / 2, 1.5).fill(theme.textDim);
        }
      }
    }
  }

  refreshParams(): void {
    this.runCtrlRedraws();
    if (this.instance.type === 'peq') this.drawPeqCurve();
    if (this.instance.type === 'vcf') this.drawVcfCurve();
    if (this.instance.type === 'knob') this.drawKnob();
    if (this.instance.type === 'slider') this.drawSlider();
    if (this.instance.type === 'xy') this.drawXy();
    if (this.instance.type === 'button') this.drawButton();
    if (this.instance.type === 'modmatrix') this.drawModMatrix();
  }

  // -- type-specific faces --------------------------------------------------

  private buildKeys(x: number, y: number, w: number): void {
    const keyW = w / KEYS.length;
    const keyH = Math.max(30, this.h - y - 12);
    KEYS.forEach((key, i) => {
      const g = new Graphics()
        .roundRect(0, 0, keyW - 2, key.black ? keyH * 0.6 : keyH, 3)
        .fill(key.black ? 0x1a1a20 : 0xe8e8ee);
      g.position.set(x + i * keyW, y);
      g.eventMode = 'static';
      g.cursor = 'pointer';
      const id = `kbd:${key.semitone}`;
      const pitch = () => 60 + key.semitone + Math.round(this.instance.params.octave ?? 0) * 12;
      g.on('pointerdown', (e) => {
        e.stopPropagation();
        appState.noteOn(this.instance.id, id, pitch());
      });
      const off = () => appState.noteOff(this.instance.id, id);
      g.on('pointerup', off);
      g.on('pointerupoutside', off);
      g.on('pointerout', off);
      this.addChild(g);
    });
  }

  private buildTransportButtons(x: number, y: number): void {
    const buttons: Array<['⏮', 'rewind'] | ['▶', 'play'] | ['⏸', 'pause'] | ['⏹', 'stop']> = [
      ['⏮', 'rewind'], ['▶', 'play'], ['⏸', 'pause'], ['⏹', 'stop'],
    ];
    buttons.forEach(([icon, cmd], i) => {
      const g = new Graphics().roundRect(0, 0, 36, 26, 5).fill(theme.button);
      g.position.set(x + i * 42, y);
      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.on('pointerdown', (e) => {
        e.stopPropagation();
        appState.transportCommand(cmd);
      });
      this.addChild(g);
      const t = new Text({ text: icon, style: { fontSize: 13, fill: theme.text } });
      t.anchor.set(0.5);
      t.position.set(x + i * 42 + 18, y + 13);
      t.eventMode = 'none';
      this.addChild(t);
    });
  }

  // -- vertical peak meter (levels / audioOut / recorder) ------------------------

  private meterBar: Graphics | null = null;
  private clipDot: Graphics | null = null;
  private meterRect = { x: 0, y: 0, w: 0, h: 0 };
  private clipped = false;

  private buildVMeter(x: number, y: number, w: number, h: number): void {
    const bg = new Graphics().roundRect(x, y, w, h, 3).fill(theme.inset);
    this.addChild(bg);
    this.meterBar = new Graphics();
    this.addChild(this.meterBar);
    this.clipDot = new Graphics();
    this.clipDot.circle(x + w / 2, y - 8, 4).fill(0x550000);
    this.clipDot.eventMode = 'static';
    this.clipDot.cursor = 'pointer';
    this.addChild(this.clipDot);
    this.meterRect = { x, y, w, h };
  }

  /** Called from the canvas ticker: live meters + sequencer playhead. */
  updateLive(): void {
    if (this.recElapsed) {
      const recording = appState.isRecording(this.instance.id);
      this.recElapsed.text = recording
        ? `${appState.recordingSeconds(this.instance.id).toFixed(1)} s`
        : appState.lastRecordingSeconds > 0
          ? `saved ${appState.lastRecordingSeconds.toFixed(1)} s`
          : '0.0 s';
      // Keep the button in sync if recording was toggled elsewhere.
      this.drawRecButton();
    }
    if (this.stepGrid) {
      const step = appState.seqSteps[this.instance.id] ?? -1;
      const current = appState.transport.playing ? step : -1;
      if (current !== this.lastDrawnStep) {
        this.lastDrawnStep = current;
        this.drawStepGrid(current);
      }
    }
    if (this.visG) this.drawVisScene();
    if (this.textFaceLine) this.updateTextFace();
    if (this.colorPrevG) {
      const cur = appState.colorValues[this.instance.id] ?? -1;
      if (cur !== this.lastPrevColor) {
        this.lastPrevColor = cur;
        const r = this.colorPrevRect;
        this.colorPrevG.clear();
        this.colorPrevG
          .roundRect(r.x, r.y, r.w, r.h, 5)
          .fill(cur >= 0 ? cur : theme.inset)
          .stroke({ width: 1, color: theme.moduleStroke });
      }
    }
    if (this.compG) {
      let pos = -1;
      if (appState.transport.playing) {
        const len = Math.max(1, Number(this.instance.data?.length) || 16);
        // Quantize the playhead to ~half-pixel steps so we redraw sparingly.
        const step = len / (this.compRect.w * 2);
        pos = Math.floor(((appState.transport.songPosition % len) + len) % len / step) * step;
      }
      if (pos !== this.lastCompPos || this.instance.data !== this.lastCompData) {
        this.lastCompPos = pos;
        this.lastCompData = this.instance.data;
        this.drawCompPreview(pos);
      }
    }
    if (this.peqSpectrumG) {
      const spectrum = appState.spectra[this.instance.id];
      if (spectrum && spectrum !== this.lastSpectrum) {
        this.lastSpectrum = spectrum;
        this.drawPeqSpectrum(spectrum);
      }
    }
    if (this.grBar) {
      // Gain reduction grows downward, red, scaled to 24 dB full height.
      const gr = appState.gainReduction[this.instance.id] ?? 0;
      const bh = Math.min(1, gr / 24) * this.grRect.h;
      this.grBar.clear();
      if (bh > 0.5) {
        this.grBar
          .roundRect(this.grRect.x, this.grRect.y, this.grRect.w, bh, 3)
          .fill(0xff5050);
      }
    }
    if (!this.meterBar) return;
    const reading = appState.meters[this.instance.id];
    const peak = reading?.peak ?? 0;
    if (reading?.clipped) this.clipped = true;
    this.meterBar.clear();
    const { x, y, w, h } = this.meterRect;
    const bh = Math.min(1, peak) * h;
    if (bh > 0.5) {
      // Vertical bar grows bottom→top, green/amber/red by level.
      this.meterBar
        .roundRect(x, y + h - bh, w, bh, 3)
        .fill(peak > 1 ? 0xff3030 : peak > 0.85 ? 0xffb13d : 0x52e07a);
    }
    if (this.clipDot) {
      this.clipDot.clear().circle(x + w / 2, y - 8, 4)
        .fill(this.clipped ? 0xff2020 : 0x550000);
      this.clipDot.off('pointerdown');
      this.clipDot.on('pointerdown', (e) => {
        e.stopPropagation();
        this.clipped = false;
      });
    }
  }

  setSelected(on: boolean): void {
    this.selected = on;
    this.drawBody(on);
  }

  /** World-space center of a port. */
  portWorldPosition(portId: string): { x: number; y: number } {
    const local = this.portCenters.get(portId)!;
    return { x: this.position.x + local.x, y: this.position.y + local.y };
  }
}

// Re-export for QWERTY mapping in chrome code.
export { KEYS, WAVEFORMS };
