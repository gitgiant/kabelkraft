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
import { sampleKey } from '../core/samples';
import {
  buildWavetable,
  defaultWavetable,
  framePoints,
  type WtTable,
} from '../core/wavetable';
import { bandCoefs, biquadResponseDb, chainResponseDb } from '../core/eqmath';
import { isTouchMode } from '../core/mobile';
import { appState } from '../state';
import { ensureAudioPermission, listAudioDevices } from '../engine/devices';
import { appSettings, updateSettings } from '../core/settings';
import { openSelectMenu } from './SelectMenu';
import { PresetBar, fitText } from './PresetBar';
import { theme } from '../theme';
import { binFrac } from '../visual/features';
import { approximateScene, visGraphOf } from '../visual/migrate';
import { ContainerRenderer, graphSupported, webgpuAvailable } from '../visual/runtime';
import { RESIZE_DIRS, inResizeBand, resizeCursor, resizeSize, type ResizeDir } from './resize';
import type { Tooltip } from './Tooltip';
import type { FaceDef, FaceRenderer } from './faces/types';
import { VcfFace } from './faces/vcf';
import { EnvelopeFace } from './faces/envelope';

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

/** Keep a tint source rendering while its tile is hidden (collapsed group) —
 * otherwise the derived tint would freeze at its last sampled color. */
const hiddenTintTick = new Map<string, number>();

export function tickHiddenTintSource(moduleId: string): void {
  const now = performance.now();
  if (now - (hiddenTintTick.get(moduleId) ?? 0) < 66) return;
  hiddenTintTick.set(moduleId, now);
  const thumb = visThumb(moduleId, 0.66);
  if (!thumb.renderer) return;
  const frame = appState.visFrame(moduleId);
  if (frame && graphSupported(frame.graph)) {
    thumb.renderer.render(frame);
  }
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
export { TITLE_H as MODULE_TITLE_H };
/** Nominal column pitch for the auto knob grid. */
const CELL_W = 46;

const CTRL_HINT =
  'Drag. Double-click: default. Shift-double-click: type. Alt-click: MIDI learn.';

/** Trim a label in place with a trailing ellipsis so it fits maxW px. */
function fitLabel(t: Text, maxW: number): void {
  if (maxW <= 0 || t.width <= maxW) return;
  const full = t.text;
  let lo = 0;
  let hi = full.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    t.text = full.slice(0, mid) + '…';
    if (t.width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  t.text = lo > 0 ? full.slice(0, lo) + '…' : '…';
}

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
export interface CtrlSpec {
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
  /** Resolved live tint (packed RGB); null = default accent. */
  private liveColor: number | null = null;

  /**
   * Per-type face table — the single source replacing the old buildFace() and
   * refreshParams() type switches and the three sizing Sets. `private` methods
   * are reachable from these arrows because TS access is class-scoped.
   */
  private static readonly FACES: Record<string, FaceDef> = {
    // -- fully custom faces (own their whole body) --------------------------
    peq: { build: (v) => v.buildPeqFace(10, TITLE_H + 6, v.w - 20), refresh: (v) => v.drawPeqCurve(), customLayout: true },
    vcf: { make: () => new VcfFace(), customLayout: true },
    envelope: { make: () => new EnvelopeFace(), customLayout: true },
    knob: { build: (v) => v.buildKnobFace(), refresh: (v) => v.drawKnob(), customLayout: true },
    slider: { build: (v) => v.buildSliderFace(), refresh: (v) => v.drawSlider(), customLayout: true },
    xy: { build: (v) => v.buildXyFace(), refresh: (v) => v.drawXy(), customLayout: true },
    button: { build: (v) => v.buildButtonFace(), refresh: (v) => v.drawButton(), customLayout: true },
    mixer: { build: (v) => v.buildMixerFace(10, TITLE_H + 18, v.w - 20), customLayout: true },
    composer: { build: (v) => v.buildComposerFace(10, TITLE_H + 6, v.w - 20), customLayout: true, unbounded: true },
    levels: { build: (v) => v.buildVMeter(v.w / 2 - 12, TITLE_H + 18, 24, v.h - TITLE_H - 32), customLayout: true },
    recorder: {
      build: (v) => {
        v.buildRecorderFace(10, TITLE_H + 10, v.w - 56);
        v.buildVMeter(v.w - 32, TITLE_H + 18, 14, v.h - TITLE_H - 32);
      },
      customLayout: true,
    },
    modmatrix: { build: (v) => v.buildModMatrixFace(10, TITLE_H + 6, v.w - 20), refresh: (v) => v.drawModMatrix(), customLayout: true },
    intelligence: { build: (v) => v.buildIntelligenceFace(10, TITLE_H + 6, v.w - 20), customLayout: true },

    // -- compositional: param band + optional edge rails / display below ----
    keyboard: { build: (v) => v.buildParamFace({ display: (c) => v.buildKeys(c.x, c.top + c.band + 4, c.gw) }), customLayout: true },
    transport: { build: (v) => v.buildParamFace({ display: (c) => v.buildTransportButtons(v.w / 2 - 84, c.top + c.band + 10) }), customLayout: true, fixedMin: true },
    sequencer: { build: (v) => v.buildParamFace({ display: (c) => v.buildStepGrid(c.x, c.top + c.band + 6, c.gw) }), customLayout: true },
    smpl: { build: (v) => v.buildParamFace({ display: (c) => v.buildSamplerFace(c.x, c.top + c.band + 6, c.gw) }), customLayout: true },
    visualizer: { build: (v) => v.buildParamFace({ display: (c) => v.buildVisFace(c.x, c.top + c.band + 4, c.gw) }), customLayout: true, unbounded: true },
    wtosc: { build: (v) => v.buildParamFace({ bottomRow: 'wavetable', display: (c) => v.buildWtDisplay(c.x, c.top + c.band + 4, c.gw, c.bottom - (c.top + c.band + 4)) }), customLayout: true },
    pluck: { build: (v) => v.buildParamFace({ display: (c) => v.buildStringDisplay(c.x, c.top + c.band + 4, c.gw, c.bottom - (c.top + c.band + 4)) }), customLayout: true },
    resonator: { build: (v) => v.buildParamFace({ display: (c) => v.buildStringDisplay(c.x, c.top + c.band + 4, c.gw, c.bottom - (c.top + c.band + 4)) }), customLayout: true },
    addosc: { build: (v) => v.buildParamFace({ display: (c) => v.buildSpectrumDisplay(c.x, c.top + c.band + 4, c.gw, c.bottom - (c.top + c.band + 4)) }), refresh: (v) => v.drawSpectrum(), customLayout: true },
    granular: {
      build: (v) =>
        v.buildParamFace({
          display: (c) => {
            v.buildGrainDisplay(c.x, c.top + c.band + 4, c.gw, c.bottom - (c.top + c.band + 4) - 22);
            v.buildGranularSample(c.x, c.bottom - 16, c.gw);
          },
        }),
      customLayout: true,
    },
    stt: { build: (v) => v.buildParamFace({ display: (c) => v.buildTextFace(c.x, c.top + c.band + 4, c.gw) }), customLayout: true },
    textinput: { build: (v) => v.buildParamFace({ display: (c) => v.buildTextFace(c.x, c.top + c.band + 4, c.gw) }), customLayout: true },
    transporttext: { build: (v) => v.buildParamFace({ display: (c) => v.buildTextFace(c.x, c.top + c.band + 4, c.gw) }), customLayout: true },
    notenames: { build: (v) => v.buildParamFace({ display: (c) => v.buildTextFace(c.x, c.top + c.band + 4, c.gw) }), customLayout: true },
    lyrics: { build: (v) => v.buildParamFace({ display: (c) => v.buildTextFace(c.x, c.top + c.band + 4, c.gw) }), customLayout: true },
    audioIn: { build: (v) => v.buildParamFace({ rail: 'vmeterIn', bottomRow: 'audioIn' }), customLayout: true },
    audioOut: { build: (v) => v.buildParamFace({ rail: 'vmeterOut', bottomRow: 'audioOut' }), customLayout: true },
    compressor: { build: (v) => v.buildParamFace({ rail: 'grmeter' }), customLayout: true },
    limiter: { build: (v) => v.buildParamFace({ rail: 'grmeter' }), customLayout: true },
    mbcomp: { build: (v) => v.buildParamFace({ rail: 'grmeter' }), customLayout: true },
    midiIn: { build: (v) => v.buildParamFace({ bottomRow: 'midi' }), customLayout: true },
    midiOut: { build: (v) => v.buildParamFace({ bottomRow: 'midi' }), customLayout: true },
    bgvisual: { build: (v) => v.buildParamFace(), customLayout: true },
  };

  /** Pure param-grid modules (delay, reverb, lfo…) with no special layout. */
  private static readonly DEFAULT_FACE: FaceDef = { build: (v) => v.buildParamFace() };

  private faceEntry(): FaceDef {
    return ModuleView.FACES[this.instance.type] ?? ModuleView.DEFAULT_FACE;
  }

  /** This view's renderer — a migrated face's own object, or an adapter that
   * delegates to the buildXxx/drawXxx methods still living on ModuleView.
   * Assigned in the constructor (after `instance` is set), not as a field
   * initializer (those run before parameter-property assignment). */
  private face!: FaceRenderer;

  private makeFace(): FaceRenderer {
    const def = this.faceEntry();
    return def.make ? def.make() : { build: def.build!, refresh: def.refresh };
  }

  constructor(
    readonly instance: ModuleInstance,
    readonly def: ModuleDef,
    private handlers: PortHandlers,
    readonly tooltip: Tooltip,
    /** Headless: face-view embed — tile face only (no title buttons, ports,
     * resize, body drag); double-click runs onOpen instead. */
    private opts: { headless?: boolean; onOpen?: () => void } = {},
  ) {
    super();
    this.position.set(instance.x, instance.y);
    this.face = this.makeFace();
    this.rebuild();
  }

  // -- size ----------------------------------------------------------------

  /** A face draws its own layout (curves, displays, device rows, embedded
   * editors) when its entry is flagged customLayout — it keeps the def's
   * hand-tuned size; everything else is a pure param grid that auto-fits. */
  private isCustomLayout(): boolean {
    return !!this.faceEntry().customLayout || !!this.def.customFace;
  }

  /** Minimal tile size for a pure param grid: title + the densest band that
   * holds the visible params, widened only enough for the columns and ports. */
  private fitSize(): { w: number; h: number } {
    const params = this.visibleParams();
    const n = params.length;
    const maxCols = Math.max(1, Math.min(n || 1, Math.floor((this.def.width - 20) / CELL_W)));
    const rows0 = Math.ceil(Math.max(1, n) / maxCols);
    const cols = Math.max(1, Math.ceil(Math.max(1, n) / rows0));
    const gw = cols * CELL_W;
    const { rows, cellH } = this.gridLayout(n, gw, params.some((p) => !!p.options));
    const band = rows * cellH;
    const portN = Math.max(
      this.def.ports.filter((p) => p.direction === 'in').length,
      this.def.ports.filter((p) => p.direction === 'out').length,
    );
    const portH = portN ? 18 + (portN - 1) * 26 + 14 : 0;
    return {
      w: Math.max(20 + gw, 80),
      h: TITLE_H + 6 + Math.max(band, portH) + 8,
    };
  }

  /** Current tile width: instance override, else content-fit (pure param) or
   * the def's hand-tuned size (custom faces), clamped to sane bounds. */
  get w(): number {
    if (this.instance.w == null && !this.isCustomLayout()) return this.fitSize().w;
    return this.clampSize(this.instance.w ?? this.def.width, this.def.width);
  }

  get h(): number {
    if (this.instance.h == null && !this.isCustomLayout()) return this.fitSize().h;
    return this.clampSize(this.instance.h ?? this.def.height, this.def.height);
  }

  private clampSize(v: number, base: number): number {
    const entry = this.faceEntry();
    const lo = entry.fixedMin ? base : Math.max(80, base * 0.7);
    const min = Math.max(lo, this.rollMin(base), v);
    return entry.unbounded ? min : Math.min(base * 3, min);
  }

  /** While the piano roll is open inside a composer, the tile can't shrink
   * below a usable editor size (shrink via the title-bar toggle instead). */
  private rollMin(base: number): number {
    // Embeds must not grow when the roll opens — the overlay pins to them as-is.
    if (this.opts.headless) return 0;
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
    this.mixMeters = [];
    this.grBar = null;
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
    // (vcf curve state now lives on VcfFace)
    this.wtRowTextA = null;
    this.wtRowTextB = null;
    this.wtDisplay = null;
    this.wtTableA = null;
    this.wtTableB = null;
    this.recButton = null;
    this.recLabel = null;
    this.recElapsed = null;
    this.waveform = null;
    this.sampleNameText = null;
    this.stepGrid = null;
    this.lastDrawnStep = -1;

    this.body = new Graphics();
    this.addChild(this.body);
    this.drawBody(this.selected);
    if (this.opts.headless) {
      this.buildHeadlessBody();
      this.buildFace();
      return;
    }
    // Handles sit just above the body so ports/face/title (added next) win hit
    // priority in their bands, while the handles still beat body-drag on edges.
    this.mountResizeHandles();
    this.buildTitle();
    this.buildPorts();
    this.buildFace();
  }

  /** Headless body: swallows drags (the group tile underneath must not move
   * from inside the view) and double-taps into the target's editor. */
  private buildHeadlessBody(): void {
    this.body.eventMode = 'static';
    this.body.cursor = this.opts.onOpen ? 'pointer' : 'default';
    let lastTap = 0;
    this.body.on('pointertap', () => {
      const now = performance.now();
      if (now - lastTap < 350) {
        lastTap = 0;
        this.opts.onOpen?.();
      } else {
        lastTap = now;
      }
    });
    this.body.on('pointerover', (e) =>
      this.tooltip.show(
        [
          this.instance.label ?? this.def.name,
          this.opts.onOpen ? 'Live view — double-click to open.' : 'Live view.',
        ],
        e.clientX,
        e.clientY,
      ),
    );
    this.body.on('pointerout', () => this.tooltip.hide());
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
    if (this.opts.headless) return; // no resize affordance on embeds
    // Resize grip glyph (se corner) — discoverability for the all-sides handles.
    this.body.moveTo(w - 13, h - 4).lineTo(w - 4, h - 13)
      .stroke({ width: 1.5, color: theme.textDim, alpha: 0.8 });
    this.body.moveTo(w - 8, h - 4).lineTo(w - 4, h - 8)
      .stroke({ width: 1.5, color: theme.textDim, alpha: 0.8 });
  }

  /** Resolved tint (own tint port or enclosing group); redraws accents when it changes. */
  setLiveColor(color: number | null): void {
    if (color === this.liveColor) return;
    this.liveColor = color;
    this.drawBody(this.selected);
    this.refreshParams();
  }

  /** Accent for control visuals: the resolved tint, else the control type color. */
  private accent(): number {
    return this.liveColor ?? PORT_TYPE_COLORS.control;
  }

  private buildTitle(): void {
    // Glyph buttons occupy the right end of the title bar (per module type);
    // the preset picker sits just left of them, the (truncated) name at left.
    const hasAiButton = this.instance.type === 'lyrics' || this.instance.type === 'visualizer';
    const rightInset = this.instance.type === 'composer' ? 44 : hasAiButton ? 22 : 4;
    const pickerRightX = this.w - rightInset;
    const nameMaxW = Math.max(24, Math.min(90, (pickerRightX - 8) * 0.5));
    const titleMaxW = Math.max(16, pickerRightX - (nameMaxW + 36) - 14);

    const title = fitText(this.instance.label ?? this.def.name, titleMaxW, theme.text);
    title.position.set(8, 5);
    // Let title-bar clicks fall through to the body (drag, double-click) —
    // group tiles do the same.
    title.eventMode = 'none';
    this.addChild(title);

    // Container title-bar buttons (GroupView pattern: fixed hit rects, since
    // glyph bounds are font-dependent).
    const titleButton = (glyph: string, x: number, tip: string[], onTap: () => void): void => {
      const t = new Text({ text: glyph, style: { fontSize: 11, fill: theme.textDim } });
      t.anchor.set(1, 0);
      t.position.set(x, 6);
      t.eventMode = 'none';
      this.addChild(t);
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

    // Composer: group-tile-style title-bar toggle — ⛶ opens the roll in
    // place, ⤡ shrinks back to the compact preview tile — plus AI clip writing.
    if (this.instance.type === 'composer') {
      const open = appState.composerOpen.has(this.instance.id);
      titleButton(
        open ? '⤡' : '⛶',
        this.w - 8,
        open
          ? ['Shrink', 'Collapse back to the compact clip tile.']
          : ['Open piano roll', 'Expand the editor inside the module.'],
        () => {
          if (appState.composerOpen.has(this.instance.id)) appState.closeComposer(this.instance.id);
          else appState.openComposer(this.instance.id);
        },
      );
      titleButton('🤖', this.w - 28, ['AI clip', 'Describe a melody or beat — the AI writes this clip.'], () =>
        appState.requestComposerAi(this.instance.id),
      );
    }

    // Lyrics: AI line writing — opens the timed-sheet editor with its AI popup.
    if (this.instance.type === 'lyrics') {
      titleButton('🤖', this.w - 8, ['AI lyrics', 'Describe a song — the AI writes timed lyric lines.'], () =>
        appState.requestLyricsAi(this.instance.id),
      );
    }

    // Visualizer: AI scene writing — opens the graph editor, whose AI bar
    // carries the container's full configuration (inputs + current graph).
    if (this.instance.type === 'visualizer') {
      titleButton('🤖', this.w - 8, ['AI visuals', 'Describe a scene — the AI rewrites this visual graph.'], () =>
        appState.openVisEditor(this.instance.id),
      );
    }

    // Preset picker (◀ name ▶), right-aligned before the glyph buttons.
    this.addChild(
      new PresetBar({
        target: { id: this.instance.id, isGroup: false },
        rightX: pickerRightX,
        y: 5,
        maxNameW: nameMaxW,
        tooltip: this.tooltip,
      }),
    );

    this.body.eventMode = 'static';
    this.body.cursor = 'grab';
    this.body.on('pointerdown', (e) => this.handlers.onBodyDown(this, e));
    // Containers: double-click the title bar toggles the grown in-place
    // editor ↔ compact tile — the same gesture as group tiles (PRD §6).
    const toggle = this.containerToggle();
    if (toggle) {
      // Manual double-tap timer (GroupView pattern): native e.detail keeps
      // counting past 2 across rapid successive double-clicks.
      let lastTap = 0;
      this.body.on('pointertap', (e) => {
        if (this.toLocal(e.global).y > TITLE_H) return;
        const now = performance.now();
        if (now - lastTap < 350) {
          lastTap = 0;
          toggle();
        } else {
          lastTap = now;
        }
      });
    }
    this.body.on('pointerover', (e) =>
      this.tooltip.show(
        [this.instance.label ?? this.def.name, this.def.description],
        e.clientX,
        e.clientY,
      ),
    );
    this.body.on('pointerout', () => this.tooltip.hide());
  }

  /** Open ↔ shrink action for container tiles (null = not a container). */
  private containerToggle(): (() => void) | null {
    const id = this.instance.id;
    if (this.instance.type === 'composer') {
      return () =>
        appState.composerOpen.has(id) ? appState.closeComposer(id) : appState.openComposer(id);
    }
    if (this.instance.type === 'visualizer') {
      // Title bar dblclick targets the graph editor (in-tile, like the
      // composer's piano roll); the big display view keeps its ⛶ button.
      return () => {
        if (appState.visEditorOpen === id) appState.closeVisEditor();
        else if (appState.visualizerOpen === id) appState.closeVisualizer();
        else appState.openVisEditor(id);
      };
    }
    return null;
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
        // Generous hit area — PRD §13 touch targets; fatter in touch mode.
        dot.hitArea = {
          contains: (px: number, py: number) => {
            const r = isTouchMode() ? 28 : 20;
            return px * px + py * py < r * r;
          },
        };
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
  visibleParams(): ParamSpec[] {
    return this.def.params;
  }

  /** No module rebuilds its face on a param change since the monolith synth left. */
  faceStale(): boolean {
    return false;
  }

  paramCtrl(p: ParamSpec): CtrlSpec {
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

  paramSpec(id: string): ParamSpec {
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

  ctrlFromNorm(c: CtrlSpec, n: number): number {
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

  /** Rotary knob for a continuous control. Value is shown on hover/drag only;
   * the persistent readout is dropped to keep cells dense. */
  buildKnob(c: CtrlSpec, cx: number, cy: number, r: number, maxW?: number): void {
    this.paramAnchors.set(c.key, { x: cx, y: cy });
    const g = new Graphics();
    this.addChild(g);
    const label = new Text({ text: c.label, style: { fontSize: 9, fill: theme.textDim } });
    label.anchor.set(0.5, 1);
    label.position.set(cx, cy - r - 3);
    label.eventMode = 'none';
    if (maxW) fitLabel(label, maxW);
    this.addChild(label);

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
      g.arc(cx, cy, r, a0, av).stroke({ width: 3, color: this.accent() });
      g.moveTo(cx + Math.cos(av) * r * 0.25, cy + Math.sin(av) * r * 0.25)
        .lineTo(cx + Math.cos(av) * r * 0.66, cy + Math.sin(av) * r * 0.66)
        .stroke({ width: 2, color: this.accent() });
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
  buildSelector(c: CtrlSpec, cx: number, cy: number, r: number, maxW?: number): void {
    this.paramAnchors.set(c.key, { x: cx, y: cy });
    const opts = c.options!;
    const g = new Graphics();
    this.addChild(g);
    const label = new Text({ text: c.label, style: { fontSize: 9, fill: theme.textDim } });
    label.anchor.set(0.5, 1);
    label.position.set(cx, cy - r - 3);
    label.eventMode = 'none';
    if (maxW) fitLabel(label, maxW);
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
          .stroke({ width: 2, color: i === idx ? this.accent() : theme.moduleStroke });
      }
      const av = angleFor(idx);
      g.moveTo(cx + Math.cos(av) * r * 0.2, cy + Math.sin(av) * r * 0.2)
        .lineTo(cx + Math.cos(av) * r * 0.66, cy + Math.sin(av) * r * 0.66)
        .stroke({ width: 2.5, color: this.accent() });
      value.text = opts[idx] ?? '';
      if (maxW) fitLabel(value, maxW + 8);
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
      g.roundRect(x, y + h * (1 - n), w, h * n, 4).fill(this.accent());
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

  /** Grid geometry for n controls across width w. Disc fills the column; row
   * height is exactly the control stack (label + disc, plus a value line when
   * a selector is present), so no empty band trails the knobs. */
  private gridLayout(n: number, w: number, hasSelector: boolean): {
    cols: number; rows: number; cellW: number; cellH: number; r: number;
  } {
    const count = Math.max(1, n);
    // Balance columns so the last row isn't a lonely stub (7 → 4+3, not 5+2).
    const maxCols = Math.max(1, Math.min(count, Math.floor(w / CELL_W)));
    const rows = Math.ceil(count / maxCols);
    const cols = Math.max(1, Math.ceil(count / rows));
    const cellW = w / cols;
    const r = Math.max(9, Math.min(18, (cellW - 12) / 2));
    const cellH = (hasSelector ? 26 : 13) + 2 * r + 4;
    return { cols, rows, cellW, cellH, r };
  }

  /** Lay controls out in a grid anchored at (x,y); rows are content-tight. */
  buildCtrlGrid(ctrls: CtrlSpec[], x: number, y: number, w: number): void {
    if (!ctrls.length) return;
    const hasSel = ctrls.some((c) => c.options);
    const { cols, cellW, cellH, r } = this.gridLayout(ctrls.length, w, hasSel);
    ctrls.forEach((c, i) => {
      const cx = x + (i % cols) * cellW + cellW / 2;
      const cy = y + Math.floor(i / cols) * cellH + 13 + r;
      if (c.options) this.buildSelector(c, cx, cy, r, cellW - 4);
      else this.buildKnob(c, cx, cy, r, cellW - 4);
    });
  }

  /** Height of the knob band for these controls in the given width. */
  ctrlBandH(ctrls: CtrlSpec[], w: number): number {
    if (!ctrls.length) return 0;
    const { rows, cellH } = this.gridLayout(ctrls.length, w, ctrls.some((c) => c.options));
    return rows * cellH;
  }

  // -- face dispatch -----------------------------------------------------------

  private buildFace(): void {
    this.face.build(this);
  }

  /**
   * Param-grid faces: a knob band, with an optional edge meter / device-row
   * rail and a type-specific display below. The rail and band arithmetic lives
   * here so every compositional face shares it (see the FACES table).
   */
  private buildParamFace(opts: {
    rail?: 'vmeterOut' | 'vmeterIn' | 'grmeter';
    bottomRow?: 'wavetable' | 'midi' | 'audioIn' | 'audioOut';
    display?: (ctx: { x: number; top: number; gw: number; band: number; bottom: number }) => void;
  } = {}): void {
    const x = 10;
    const w = this.w - 20;
    const top = TITLE_H + 6;
    const ctrls = this.visibleParams().map((p) => this.paramCtrl(p));

    // Vertical meter rail in a right-edge column.
    let right = this.w - 10;
    if (opts.rail === 'vmeterOut') {
      this.buildVMeter(this.w - 30, top + 12, 14, this.h - top - 26);
      right = this.w - 44;
    } else if (opts.rail === 'vmeterIn') {
      this.buildVMeter(this.w - 30, top + 12, 14, this.h - top - 40);
      right = this.w - 44;
    } else if (opts.rail === 'grmeter') {
      this.buildGrMeter(this.w - 28, top + 12, 12, this.h - top - 26);
      right = this.w - 42;
    }

    // Bottom-anchored utility row.
    let bottom = this.h - 8;
    if (opts.bottomRow === 'wavetable') {
      this.buildWavetableRow(x, this.h - 40, w);
      bottom -= 42;
    } else if (opts.bottomRow === 'midi') {
      this.buildMidiDeviceRow(x, this.h - 24, w);
      bottom -= 26;
    } else if (opts.bottomRow === 'audioIn') {
      this.buildAudioDeviceRow(x, this.h - 24, w);
      bottom -= 26;
    } else if (opts.bottomRow === 'audioOut') {
      this.buildAudioOutputDeviceRow(x, this.h - 24, w);
      bottom -= 26;
    }

    const gw = right - x;
    const band = this.ctrlBandH(ctrls, gw);
    this.buildCtrlGrid(ctrls, x, top, gw);
    opts.display?.({ x, top, gw, band, bottom });
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
      .stroke({ width: 3, color: this.accent() });
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

  // -- mixer face: 5 console strips (4 channels + master bus) --------------------

  private mixMeters: Array<{
    key: string;
    x: number;
    y: number;
    w: number;
    h: number;
    bar: Graphics;
    dot: Graphics;
    clipped: boolean;
  }> = [];

  private buildMixerFace(x: number, y: number, w: number): void {
    const chW = w / 5;
    const r = Math.max(9, Math.min(13, chW * 0.22));
    const pitch = r * 2 + 24;
    const knobIds = ['eqHi', 'eqMid', 'eqLo', 'filt', 'send'];
    for (let ch = 1; ch <= 5; ch++) {
      const cx = x + (ch - 1) * chW + chW / 2;
      knobIds.forEach((pid, k) => {
        this.buildKnob(this.paramCtrl(this.paramSpec(`${pid}${ch}`)), cx, y + r + 12 + k * pitch, r);
      });
      const panCy = this.h - r - 24;
      this.buildKnob(this.paramCtrl(this.paramSpec(`pan${ch}`)), cx, panCy, r);

      // Fader with its strip meter beside it (channels pre-fader, master = out).
      const fy = y + 24 + knobIds.length * pitch;
      const fh = Math.max(40, panCy - r - 30 - fy);
      const fw = Math.max(10, Math.min(14, chW * 0.22));
      const mw = 5;
      const fx = cx - (fw + 3 + mw) / 2;
      this.buildFader(this.paramCtrl(this.paramSpec(`lvl${ch}`)), fx, fy, fw, fh);
      const mx = fx + fw + 3;
      this.addChild(new Graphics().roundRect(mx, fy, mw, fh, 2).fill(theme.inset));
      const bar = new Graphics();
      bar.eventMode = 'none';
      this.addChild(bar);
      const dot = new Graphics();
      dot.eventMode = 'static';
      dot.cursor = 'pointer';
      this.addChild(dot);
      const m = {
        key: ch === 5 ? this.instance.id : `${this.instance.id}:ch${ch}`,
        x: mx,
        y: fy,
        w: mw,
        h: fh,
        bar,
        dot,
        clipped: false,
      };
      dot.circle(mx + mw / 2, fy - 6, 3).fill(0x550000);
      dot.on('pointerdown', (e) => {
        e.stopPropagation();
        m.clipped = false;
      });
      this.mixMeters.push(m);
    }
  }

  /** Send poles show only while their knob is up or a wire is attached. */
  private updateSendPoles(): void {
    let wired: Set<string> | null = null;
    for (let ch = 1; ch <= 5; ch++) {
      const pid = `send${ch}`;
      const dot = this.portDots.get(pid);
      if (!dot) continue;
      if ((this.instance.params[pid] ?? 0) > 0.001) {
        dot.visible = true;
        continue;
      }
      if (!wired) {
        wired = new Set();
        for (const wire of appState.graph.wires.values()) {
          if (wire.from.moduleId === this.instance.id) wired.add(wire.from.portId);
        }
      }
      dot.visible = wired.has(pid);
    }
  }

  // -- composer face (PRD §8.3, piano roll) --------------------------------------

  private compG: Graphics | null = null;
  private compRect = { x: 0, y: 0, w: 0, h: 0 };
  private lastCompPos = -1;
  private lastCompData: unknown = null;

  private buildComposerFace(x: number, y: number, w: number): void {
    const h = this.h - y - 12;
    this.compRect = { x, y, w, h };
    const bg = new Graphics().roundRect(x, y, w, h, 4).fill(theme.graphBg);
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
    const bg = new Graphics().roundRect(x, y, w, h, 4).fill(theme.graphBg);
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
   * TODO(intelligence): placeholder face only. One mock "AI prompt window"
   * row appears per wired input type; nothing generates yet. Planned: each
   * row opens an input-aware prompt panel (audio → analysis, notes → MIDI
   * generation, text → lyrics/visual prompts, visual → scene edits) through
   * the shared buildAiContext() pipeline, plus matching output ports.
   */
  private buildIntelligenceFace(x: number, y: number, w: number): void {
    const wired = this.def.ports.filter(
      (p) =>
        p.direction === 'in' &&
        [...appState.graph.wires.values()].some(
          (wr) => wr.to.moduleId === this.instance.id && wr.to.portId === p.id,
        ),
    );

    if (wired.length === 0) {
      const hint = new Text({
        text: '🤖 Wire any signal in —\na matching AI prompt\nwindow appears here.',
        style: { fontSize: 11, fill: theme.textDim, lineHeight: 17 },
      });
      hint.position.set(x, y + 6);
      this.addChild(hint);
      return;
    }

    let py = y + 2;
    const rowH = 40;
    for (const p of wired) {
      if (py + rowH > this.h - 12) break; // stretch the tile for more rows
      const g = new Graphics();
      g.roundRect(x, py, w, rowH - 6, 6)
        .fill({ color: 0x000000, alpha: 0.2 })
        .stroke({ width: 1, color: theme.moduleStroke });
      g.circle(x + 12, py + (rowH - 6) / 2, 4).fill(PORT_TYPE_COLORS[p.type]);
      this.addChild(g);
      const label = new Text({
        text: `${p.label} prompt`,
        style: { fontSize: 11, fontWeight: '700', fill: theme.text },
      });
      label.position.set(x + 24, py + 5);
      this.addChild(label);
      const stub = new Text({
        text: '✨ Describe what to generate… (coming soon)',
        style: { fontSize: 9, fill: theme.textDim },
      });
      stub.position.set(x + 24, py + 19);
      this.addChild(stub);
      py += rowH;
    }
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
    const bg = new Graphics().roundRect(x, y, w, h, 4).fill(theme.graphBg);
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
    if (type === 'stt' || type === 'textinput' || type === 'lyrics') {
      bg.eventMode = 'static';
      bg.cursor = 'pointer';
      bg.on('pointerdown', (e) => {
        e.stopPropagation();
        if (type === 'stt') {
          const on = appState.toggleStt(this.instance.id);
          if (!on && !appState.stt.supported()) {
            this.tooltip.show(['Speech to Text', 'Speech recognition is not available in this browser.'], e.clientX, e.clientY);
          }
        } else if (type === 'lyrics') {
          appState.openLyrics(this.instance.id);
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
            : type === 'lyrics'
              ? ['Lyrics', 'Click to open the timed-lyrics editor (AI or hand-write).']
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
          : type === 'lyrics'
            ? `${((this.instance.data?.lines as unknown[])?.length ?? 0)} lines · click to edit`
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

  // -- Audio capture device row (audioIn) ---------------------------------------

  private audioDeviceText: Text | null = null;

  private buildAudioDeviceRow(x: number, y: number, w: number): void {
    this.audioDeviceText = new Text({ text: '', style: { fontSize: 10, fill: theme.textDim } });
    this.audioDeviceText.position.set(x, y);
    this.addChild(this.audioDeviceText);
    this.updateAudioDeviceText();

    const hit = new Graphics().rect(x - 4, y - 4, w + 8, 18).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const sx = e.clientX;
      const sy = e.clientY;
      void (async () => {
        await ensureAudioPermission();
        const { inputs } = await listAudioDevices();
        const devices = [{ deviceId: '', label: 'default input' }, ...inputs];
        const current = (this.instance.data?.deviceId as string) || '';
        openSelectMenu({
          x: sx,
          y: sy,
          items: devices.map((d) => ({ label: d.label, value: d.deviceId, selected: d.deviceId === current })),
          onPick: (deviceId) => {
            const dev = devices.find((d) => d.deviceId === deviceId);
            appState.setModuleData(this.instance.id, 'deviceId', deviceId);
            appState.setModuleData(this.instance.id, 'deviceName', dev?.label ?? 'default input');
            this.updateAudioDeviceText();
          },
        });
      })();
    });
    hit.on('pointerover', (e) =>
      this.tooltip.show(
        ['Capture device', 'Click to choose an input (asks for microphone permission first).'],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  private updateAudioDeviceText(): void {
    if (!this.audioDeviceText) return;
    const name = (this.instance.data?.deviceName as string) || 'default input';
    this.audioDeviceText.text = `in: ${name}`;
  }

  // -- Audio output device row (audioOut) --------------------------------------
  // Output device is machine-level (one AudioContext = one hardware sink), so
  // this drives the global sinkId setting and restarts the engine, mirroring
  // Options → Audio rather than storing a device id in the project.

  private audioOutDeviceText: Text | null = null;

  private buildAudioOutputDeviceRow(x: number, y: number, w: number): void {
    this.audioOutDeviceText = new Text({ text: '', style: { fontSize: 10, fill: theme.textDim } });
    this.audioOutDeviceText.position.set(x, y);
    this.addChild(this.audioOutDeviceText);
    this.updateAudioOutDeviceText();

    const hit = new Graphics().rect(x - 4, y - 4, w + 8, 18).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const sx = e.clientX;
      const sy = e.clientY;
      void (async () => {
        await ensureAudioPermission();
        const { outputs } = await listAudioDevices();
        const devices = [{ deviceId: '', label: 'default output' }, ...outputs];
        const current = appSettings().audio.sinkId || '';
        openSelectMenu({
          x: sx,
          y: sy,
          items: devices.map((d) => ({ label: d.label, value: d.deviceId, selected: d.deviceId === current })),
          onPick: (deviceId) => {
            updateSettings((s) => { s.audio.sinkId = deviceId; });
            if (appState.engine.started) void appState.restartEngine();
            this.updateAudioOutDeviceText();
          },
        });
      })();
    });
    hit.on('pointerover', (e) =>
      this.tooltip.show(
        ['Output device', 'Click to choose the hardware output (applies to the whole project; brief audio dropout).'],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  private updateAudioOutDeviceText(): void {
    if (!this.audioOutDeviceText) return;
    const sinkId = appSettings().audio.sinkId || '';
    void (async () => {
      let name = 'default output';
      if (sinkId) {
        const { outputs } = await listAudioDevices();
        name = outputs.find((d) => d.deviceId === sinkId)?.label || sinkId;
      }
      if (this.audioOutDeviceText) this.audioOutDeviceText.text = `out: ${name}`;
    })();
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

  private wtRowTextA: Text | null = null;
  private wtRowTextB: Text | null = null;

  private buildWavetableRow(x: number, y: number, w: number): void {
    this.wtRowTextA = this.buildWtSlotRow(x, y, w, 0);
    this.wtRowTextB = this.buildWtSlotRow(x, y + 18, w, 1);
    this.updateWtRowText();
  }

  /** One A/B wavetable-slot row: label text + click-to-load hit rect. */
  private buildWtSlotRow(x: number, y: number, w: number, slot: number): Text {
    const text = new Text({ text: '', style: { fontSize: 10, fill: theme.textDim } });
    text.position.set(x, y);
    this.addChild(text);

    const hit = new Graphics().rect(x - 4, y - 3, w + 8, 17).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void appState.loadSampleFile(this.instance.id, file, slot);
      };
      input.click();
    });
    hit.on('pointerover', (e) =>
      this.tooltip.show(
        [
          `Wavetable ${slot === 1 ? 'B' : 'A'}`,
          'Click to load a wavetable file (2048-sample frames; short files become one cycle). Morph crossfades A↔B.',
        ],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
    return text;
  }

  private updateWtRowText(): void {
    const data = this.instance.data ?? {};
    if (this.wtRowTextA) {
      const a = (data.sampleNameA as string) || '';
      this.wtRowTextA.text = a ? `A: ${a}` : 'A: built-in — click to load';
    }
    if (this.wtRowTextB) {
      const b = (data.sampleNameB as string) || '';
      this.wtRowTextB.text = b ? `B: ${b}` : 'B: (empty) — click to load';
    }
  }

  // -- wavetable display: 2.5D frame stack + resolved output cycle -----------

  private wtDisplay: Graphics | null = null;
  private wtDisplayRect = { x: 0, y: 0, w: 0, h: 0 };
  private wtTableA: WtTable | null = null;
  private wtTableB: WtTable | null = null;
  private wtLastDraw = { pos: -1, morph: -1 };

  private buildWtDisplay(x: number, y: number, w: number, h: number): void {
    this.wtDisplayRect = { x, y, w, h: Math.max(40, h) };
    this.wtDisplay = new Graphics();
    this.addChild(this.wtDisplay);
    this.rebuildWtTables();
    this.wtLastDraw = { pos: -1, morph: -1 };
    this.drawWtDisplay(0, 0);
  }

  /** (Re)build the A/B frame tables from loaded PCM, or the built-in default for A. */
  private rebuildWtTables(): void {
    const a = appState.samples.get(sampleKey(this.instance.id, 0));
    const b = appState.samples.get(sampleKey(this.instance.id, 1));
    this.wtTableA = (a && buildWavetable(a.channels[0])) || defaultWavetable();
    this.wtTableB = (b && buildWavetable(b.channels[0])) || null;
    this.wtLastDraw = { pos: -1, morph: -1 }; // force redraw with fresh tables
  }

  private drawWtDisplay(pos: number, morph: number): void {
    const g = this.wtDisplay;
    if (!g || !this.wtTableA) return;
    const { x, y, w, h } = this.wtDisplayRect;
    g.clear();
    g.roundRect(x, y, w, h, 4).fill({ color: 0x0d0d14 }).stroke({ width: 1, color: 0x2a2a36 });

    const stackH = h * 0.6;
    const cycleH = h - stackH;
    const N = 72;

    // -- 2.5D frame stack (back-to-front), highlight the frame at `pos` ------
    const wtA = this.wtTableA;
    const shown = Math.min(wtA.frames, 16);
    const depthX = w * 0.22;
    const plotW = w - depthX - 10;
    const rowTop = y + 8;
    const rowH = stackH - 16;
    const curFrame = pos * (wtA.frames - 1);
    for (let s = 0; s < shown; s++) {
      const f = shown === 1 ? 0 : (s / (shown - 1)) * (wtA.frames - 1);
      const depth = shown === 1 ? 1 : s / (shown - 1); // 0 = back, 1 = front
      const ox = x + 6 + (1 - depth) * depthX;
      const oy = rowTop + depth * (rowH - 14) + 10;
      const amp = 5 + depth * 7;
      const near = Math.abs(f - curFrame) < (wtA.frames - 1) / shown / 2 + 0.5;
      const pts = framePoints(wtA, wtA.frames > 1 ? f / (wtA.frames - 1) : 0, N);
      for (let k = 0; k < N; k++) {
        const px = ox + (k / (N - 1)) * plotW;
        const py = oy - pts[k] * amp;
        if (k === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke({ width: near ? 1.6 : 1, color: near ? 0xffb13d : 0x4a4a64, alpha: near ? 1 : 0.5 + depth * 0.3 });
    }

    // -- resolved output cycle (A@pos crossfaded with B@pos by morph) --------
    const cy = y + stackH + cycleH / 2;
    const cAmp = cycleH / 2 - 6;
    const aPts = framePoints(wtA, pos, N);
    const bPts = morph > 0 && this.wtTableB ? framePoints(this.wtTableB, pos, N) : null;
    for (let k = 0; k < N; k++) {
      const v = bPts ? aPts[k] * (1 - morph) + bPts[k] * morph : aPts[k];
      const px = x + 6 + (k / (N - 1)) * (w - 12);
      const py = cy - v * cAmp;
      if (k === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke({ width: 1.8, color: 0xffb13d });
  }

  // -- pluck / resonator string display --------------------------------------

  private stringG: Graphics | null = null;
  private stringRect = { x: 0, y: 0, w: 0, h: 0 };
  private stringWasActive = false;

  private buildStringDisplay(x: number, y: number, w: number, h: number): void {
    this.stringRect = { x, y, w: Math.max(40, w), h: Math.max(30, h) };
    this.stringG = new Graphics();
    this.addChild(this.stringG);
    this.drawString(null);
  }

  private drawString(data: { s: Float32Array; a: number } | null): void {
    const g = this.stringG;
    if (!g) return;
    const { x, y, w, h } = this.stringRect;
    g.clear();
    g.roundRect(x, y, w, h, 4).fill({ color: 0x0d0d14 }).stroke({ width: 1, color: 0x2a2a36 });
    const cy = y + h / 2;
    const arr = data ? data.s : null;
    if (!arr || arr.length === 0) {
      g.moveTo(x + 6, cy).lineTo(x + w - 6, cy).stroke({ width: 1.5, color: 0x4a4a64 });
      return;
    }
    const N = arr.length;
    let peak = 1e-4;
    for (let k = 0; k < N; k++) { const a = Math.abs(arr[k]); if (a > peak) peak = a; }
    const amp = (h / 2 - 6) / Math.max(0.2, peak);
    const active = !!(data && data.a > 0.5);
    for (let k = 0; k < N; k++) {
      const px = x + 6 + (k / (N - 1)) * (w - 12);
      const py = cy - arr[k] * amp;
      if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.stroke({ width: 1.8, color: active ? 0xffb13d : 0x6a6a84 });
  }

  // -- additive spectrum display (UI-computed from params) -------------------

  private spectrumG: Graphics | null = null;
  private spectrumRect = { x: 0, y: 0, w: 0, h: 0 };

  private buildSpectrumDisplay(x: number, y: number, w: number, h: number): void {
    this.spectrumRect = { x, y, w: Math.max(40, w), h: Math.max(30, h) };
    this.spectrumG = new Graphics();
    this.addChild(this.spectrumG);
    this.drawSpectrum();
  }

  private drawSpectrum(): void {
    const g = this.spectrumG;
    if (!g) return;
    const { x, y, w, h } = this.spectrumRect;
    g.clear();
    g.roundRect(x, y, w, h, 4).fill({ color: 0x0d0d14 }).stroke({ width: 1, color: 0x2a2a36 });
    const p = this.instance.params;
    const P = Math.max(1, Math.min(64, Math.round(Number(p.partials) || 16)));
    const tExp = (Number(p.tilt) || 0) / 6.0206;
    const b = Math.min(1, Math.max(0, Number(p.odd ?? 0.5))) * 2 - 1;
    const gains: number[] = [];
    let peak = 1e-4;
    for (let hh = 1; hh <= P; hh++) {
      let gv = Math.pow(hh, tExp);
      if (b > 0) { if (hh % 2 === 0) gv *= 1 - b; }
      else if (b < 0) { if (hh % 2 === 1) gv *= 1 + b; }
      gains.push(gv);
      if (gv > peak) peak = gv;
    }
    const bw = (w - 12) / P;
    const base = y + h - 6;
    for (let i = 0; i < P; i++) {
      const bh = (gains[i] / peak) * (h - 12);
      const bx = x + 6 + i * bw;
      g.rect(bx, base - bh, Math.max(1, bw - 1), bh).fill({ color: this.accent(), alpha: 0.85 });
    }
  }

  // -- granular grain cloud + sample load ------------------------------------

  private grainG: Graphics | null = null;
  private grainRect = { x: 0, y: 0, w: 0, h: 0 };
  private grainSampleText: Text | null = null;

  private buildGrainDisplay(x: number, y: number, w: number, h: number): void {
    this.grainRect = { x, y, w: Math.max(40, w), h: Math.max(24, h) };
    this.grainG = new Graphics();
    this.addChild(this.grainG);
    this.drawGrains(null);
  }

  private drawGrains(data: { g: Float32Array; c: number } | null): void {
    const g = this.grainG;
    if (!g) return;
    const { x, y, w, h } = this.grainRect;
    g.clear();
    g.roundRect(x, y, w, h, 4).fill({ color: 0x0d0d14 }).stroke({ width: 1, color: 0x2a2a36 });
    if (!data || data.c === 0) return;
    const c = data.c;
    for (let i = 0; i < c; i++) {
      const gx = x + 4 + Math.min(1, Math.max(0, data.g[i * 3])) * (w - 8);
      // y by playback rate (pitch): map ~0.25..4× across the height (log2)
      const rate = data.g[i * 3 + 1] || 1;
      const ny = Math.min(1, Math.max(0, (Math.log2(rate) + 2) / 4));
      const gy = y + h - 4 - ny * (h - 8);
      const phase = data.g[i * 3 + 2];
      const a = Math.sin(Math.PI * Math.min(1, Math.max(0, phase))); // fade in/out
      g.circle(gx, gy, 2).fill({ color: this.accent(), alpha: 0.25 + 0.6 * a });
    }
  }

  private buildGranularSample(x: number, y: number, w: number): void {
    this.grainSampleText = new Text({ text: '', style: { fontSize: 10, fill: theme.textDim } });
    this.grainSampleText.position.set(x, y);
    this.grainSampleText.eventMode = 'static';
    this.grainSampleText.cursor = 'pointer';
    this.grainSampleText.on('pointerdown', (e) => {
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
    this.grainSampleText.on('pointerover', (e) =>
      this.tooltip.show(['Sample', 'Click to load an audio file to granulate (Source = sample).'], e.clientX, e.clientY),
    );
    this.grainSampleText.on('pointerout', () => this.tooltip.hide());
    this.addChild(this.grainSampleText);
    this.updateGrainSampleName();
  }

  private updateGrainSampleName(): void {
    if (!this.grainSampleText) return;
    const s = appState.samples.get(this.instance.id);
    this.grainSampleText.text = s ? `♪ ${s.name}` : '＋ load sample…';
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
    if (this.wtDisplay) this.rebuildWtTables();
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
          ).fill(amt > 0 ? this.accent() : 0x52e07a);
        } else {
          g.circle(cx + cw / 2, cy + ch / 2, 1.5).fill(theme.textDim);
        }
      }
    }
  }

  refreshParams(): void {
    this.runCtrlRedraws();
    this.face.refresh?.(this);
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
    if (this.wtDisplay) {
      const d = appState.wtData[this.instance.id];
      const params = this.instance.params;
      const pos = d ? d.pos : Math.min(1, Math.max(0, Number(params.wtPos) || 0));
      const morph = d ? d.morph : Math.min(1, Math.max(0, Number(params.morph) || 0));
      if (Math.abs(pos - this.wtLastDraw.pos) > 0.002 || Math.abs(morph - this.wtLastDraw.morph) > 0.002) {
        this.wtLastDraw = { pos, morph };
        this.drawWtDisplay(pos, morph);
      }
    }
    if (this.stringG) {
      const d = appState.stringData[this.instance.id];
      if (d || this.stringWasActive) {
        this.drawString(d ?? null);
        this.stringWasActive = !!(d && d.a > 0.5);
      }
    }
    if (this.grainG) {
      this.drawGrains(appState.grainData[this.instance.id] ?? null);
      this.updateGrainSampleName();
    }
    if (this.textFaceLine) this.updateTextFace();
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
    this.face.live?.(this);
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
    if (this.mixMeters.length > 0) {
      this.updateSendPoles();
      for (const m of this.mixMeters) {
        const r = appState.meters[m.key];
        const peak = r?.peak ?? 0;
        if (r?.clipped) m.clipped = true;
        m.bar.clear();
        const bh = Math.min(1, peak) * m.h;
        if (bh > 0.5) {
          m.bar
            .roundRect(m.x, m.y + m.h - bh, m.w, bh, 2)
            .fill(peak > 1 ? 0xff3030 : peak > 0.85 ? 0xffb13d : 0x52e07a);
        }
        m.dot.clear().circle(m.x + m.w / 2, m.y - 6, 3).fill(m.clipped ? 0xff2020 : 0x550000);
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
