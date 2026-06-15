/**
 * One module's visual on the patch canvas: resizable tile body, typed port
 * dots (inputs left, outputs right — PRD §5), knob/selector/fader controls
 * for every param (drag to change, double-click resets to default,
 * shift-double-click types a value), plus type-specific faces (keyboard keys,
 * transport buttons, meter bars, step grids…). Faces stretch with the tile.
 */

import { Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import type { ModuleDef, ParamSpec, PortSpec } from '../core/module';
import type { ModuleInstance } from '../core/module';
import type { ControlCurve } from '../core/types';
import { PORT_TYPE_COLORS } from '../core/types';
import { MODMATRIX_SIZE, WAVEFORMS } from '../core/registry';
import { clipFromData } from '../core/composer';
import { isTouchMode } from '../core/mobile';
import { appState } from '../state';
import { ensureAudioPermission, listAudioDevices } from '../engine/devices';
import { appSettings, updateSettings } from '../core/settings';
import { openSelectMenu } from './SelectMenu';
import { PresetBar, fitText } from './PresetBar';
import { theme } from '../theme';
import { RESIZE_DIRS, inResizeBand, resizeCursor, resizeSize, type ResizeDir } from './resize';
import type { Tooltip } from './Tooltip';
import type { FaceDef, FaceRenderer } from './faces/types';
import { VcfFace } from './faces/vcf';
import { EnvelopeFace } from './faces/envelope';
import { PeqFace } from './faces/peq';
import { ButtonFace, KnobFace, SliderFace, XyFace } from './faces/controls';
import { StringFace } from './faces/string';
import { SpectrumFace } from './faces/spectrum';
import { GranularFace } from './faces/granular';
import { StepGridFace } from './faces/sequencer';
import { TextFace } from './faces/text';
import { SamplerFace } from './faces/sampler';
import { WtoscFace } from './faces/wtosc';
import { VisualizerFace } from './faces/visualizer';
export { tickHiddenTintSource } from './faces/visThumb';


/** Minimal HSL→hex for particle colors. */
export function hslToHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}


export const PORT_RADIUS = 7;
const TITLE_H = 24;
export { TITLE_H as MODULE_TITLE_H };
/** Nominal column pitch for the auto knob grid. */
const CELL_W = 46;

export const CTRL_HINT =
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
    peq: { make: () => new PeqFace(), customLayout: true },
    vcf: { make: () => new VcfFace(), customLayout: true },
    envelope: { make: () => new EnvelopeFace(), customLayout: true },
    knob: { make: () => new KnobFace(), customLayout: true },
    slider: { make: () => new SliderFace(), customLayout: true },
    xy: { make: () => new XyFace(), customLayout: true },
    button: { make: () => new ButtonFace(), customLayout: true },
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
    sequencer: { make: () => new StepGridFace(), customLayout: true },
    smpl: { make: () => new SamplerFace(), customLayout: true },
    visualizer: { make: () => new VisualizerFace(), customLayout: true, unbounded: true },
    wtosc: { make: () => new WtoscFace(), customLayout: true },
    pluck: { make: () => new StringFace(), customLayout: true },
    resonator: { make: () => new StringFace(), customLayout: true },
    addosc: { make: () => new SpectrumFace(), customLayout: true },
    granular: { make: () => new GranularFace(), customLayout: true },
    stt: { make: () => new TextFace(), customLayout: true },
    textinput: { make: () => new TextFace(), customLayout: true },
    transporttext: { make: () => new TextFace(), customLayout: true },
    notenames: { make: () => new TextFace(), customLayout: true },
    lyrics: { make: () => new TextFace(), customLayout: true },
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
    this.compG = null;
    this.lastCompPos = -1;
    this.lastCompData = null;
    this.midiDeviceText = null;
    // (peq/vcf curve + wtosc table state now lives on their FaceRenderer objects)
    this.recButton = null;
    this.recLabel = null;
    this.recElapsed = null;

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
  accent(): number {
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

  /** Record a control's center so e2e/tools can aim the pointer at it. */
  setParamAnchor(key: string, x: number, y: number): void {
    this.paramAnchors.set(key, { x, y });
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

  ctrlTipTitle(c: CtrlSpec): string {
    return `${c.label}: ${this.formatCtrl(c)} (${this.ctrlRaw(c)})`;
  }

  private runCtrlRedraws(): void {
    for (const fn of this.ctrlRedraws) fn();
  }

  /**
   * Shared gesture preamble: face learn, MIDI learn (alt), double-click
   * default, shift-double-click typed entry. True = event consumed.
   */
  ctrlPreamble(c: CtrlSpec, e: FederatedPointerEvent): boolean {
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
  buildParamFace(opts: {
    rail?: 'vmeterOut' | 'vmeterIn' | 'grmeter';
    bottomRow?: 'midi' | 'audioIn' | 'audioOut';
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
    if (opts.bottomRow === 'midi') {
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

  /** A sample/wavetable loaded: let the face redraw (sampler waveform, wtosc
   * slot rows + frame tables). */
  refreshSample(): void {
    this.face.refreshSample?.(this);
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
