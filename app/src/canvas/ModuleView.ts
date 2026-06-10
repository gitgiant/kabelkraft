/**
 * One module's visual on the patch canvas: tile body, typed port dots
 * (inputs left, outputs right — PRD §5), generic param rows (drag to change,
 * click to cycle options), plus type-specific faces (keyboard keys,
 * transport buttons, meter bars).
 */

import { Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import type { ModuleDef, ParamSpec, PortSpec } from '../core/module';
import type { ModuleInstance } from '../core/module';
import { PORT_TYPE_COLORS } from '../core/types';
import {
  DRUM_DECAY_MAX,
  DRUM_PADS,
  SEQ_PITCH_MAX,
  SEQ_PITCH_MIN,
  SYNTH_MODES,
  WAVEFORMS,
  type DrumPad,
  type DrumStep,
  type SeqStep,
} from '../core/registry';
import { clipFromData } from '../core/composer';
import { bandCoefs, biquadResponseDb, chainResponseDb, vcfCoefs } from '../core/eqmath';
import { sampleKey } from '../core/samples';
import { appState } from '../state';
import { theme } from '../theme';
import type { Tooltip } from './Tooltip';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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
const ROW_H = 20;

export interface PortHandlers {
  onPortDown(moduleId: string, portId: string, e: FederatedPointerEvent): void;
  onPortUp(moduleId: string, portId: string, e: FederatedPointerEvent): void;
  onBodyDown(view: ModuleView, e: FederatedPointerEvent): void;
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
  private paramTexts = new Map<string, Text>();
  private meterBar: Graphics | null = null;
  private clipDot: Graphics | null = null;
  private portDots = new Map<string, Graphics>();
  private flashTimers = new Map<string, number>();
  private popUntil = 0;
  private popFrom = { x: 0, y: 0 };
  private static readonly POP_MS = 340;

  constructor(
    readonly instance: ModuleInstance,
    readonly def: ModuleDef,
    private handlers: PortHandlers,
    private tooltip: Tooltip,
  ) {
    super();
    this.position.set(instance.x, instance.y);
    this.addChild(this.body);
    this.drawBody(false);
    this.buildTitle();
    this.buildPorts();
    this.buildFace();
  }

  // -- construction -------------------------------------------------------

  private drawBody(selected: boolean): void {
    const { width: w, height: h } = this.def;
    this.body.clear();
    this.body
      .roundRect(0, 0, w, h, 8)
      .fill(selected ? theme.moduleBodySelected : theme.moduleBody)
      .stroke({ width: selected ? 2 : 1, color: selected ? theme.selectedStroke : theme.moduleStroke });
    this.body.roundRect(0, 0, w, TITLE_H, 8).fill(theme.moduleTitle);
    this.body.rect(0, TITLE_H - 8, w, 8).fill(theme.moduleTitle);
    if (this.instance.color !== undefined) {
      this.body.rect(0, TITLE_H, w, 3).fill(this.instance.color);
    }
  }

  private buildTitle(): void {
    const title = new Text({
      text: this.instance.label ?? this.def.name,
      style: { fontSize: 12, fill: theme.text, fontWeight: 'bold' },
    });
    title.position.set(8, 5);
    this.addChild(title);

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
    place(outputs, this.def.width);
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
      this.popFrom.x + (1 - s) * (this.def.width / 2),
      this.popFrom.y + (1 - s) * (this.def.height / 2),
    );
  }

  /** Synth mode the face was built for — mode switch rebuilds the view. */
  private builtSynthMode = -1;

  /** Mode-scoped params (ParamSpec.group) filtered by the synth's mode. */
  private visibleParams(): ParamSpec[] {
    if (this.instance.type !== 'synth') return this.def.params;
    const mode = SYNTH_MODES[Math.round(this.instance.params.mode ?? 0)] ?? 'classic';
    return this.def.params.filter((p) => !p.group || p.group === mode);
  }

  /** True when the built face no longer matches the instance (synth mode switch). */
  faceStale(): boolean {
    return (
      this.instance.type === 'synth' &&
      Math.round(this.instance.params.mode ?? 0) !== this.builtSynthMode
    );
  }

  private buildFace(): void {
    let y = TITLE_H + 8;
    const x = 18;
    const w = this.def.width - 36;

    const params = this.def.customFace ? [] : this.visibleParams();
    if (this.instance.type === 'synth' || this.def.twoColumn) {
      if (this.instance.type === 'synth') {
        this.builtSynthMode = Math.round(this.instance.params.mode ?? 0);
      }
      // Two columns — too many params for one.
      const colW = (this.def.width - 48) / 2;
      const half = Math.ceil(params.length / 2);
      params.forEach((param, i) => {
        const col = i < half ? 0 : 1;
        const row = col === 0 ? i : i - half;
        this.buildParamRow(param, 18 + col * (colW + 12), y + row * ROW_H, colW);
      });
      if (this.instance.type === 'synth' && this.builtSynthMode === 1) {
        this.buildWavetableRow(x, this.def.height - 22, w);
      }
      if (this.instance.type === 'mbcomp') {
        this.buildGrMeter(x, this.def.height - 16, w);
      }
      return;
    }

    for (const param of params) {
      this.buildParamRow(param, x, y, w);
      y += ROW_H;
    }

    if (this.instance.type === 'peq') this.buildPeqFace(x, y + 2, w);
    if (this.instance.type === 'midiIn' || this.instance.type === 'midiOut') {
      this.buildMidiDeviceRow(x, this.def.height - 22, w);
    }
    if (this.instance.type === 'keyboard') this.buildKeys(x, y + 2, w);
    if (this.instance.type === 'transport') this.buildTransportButtons(x, y + 4);
    if (
      this.instance.type === 'levels' ||
      this.instance.type === 'audioOut' ||
      this.instance.type === 'recorder'
    ) {
      this.buildMeter(x, this.def.height - 18, w);
    }
    if (this.instance.type === 'sequencer') this.buildStepGrid(x, y + 4, w);
    if (this.instance.type === 'sampler') this.buildSamplerFace(x, y + 4, w);
    if (this.instance.type === 'recorder') this.buildRecorderFace(x, y + 4, w);
    if (this.instance.type === 'drum') this.buildDrumFace(x, y + 4, w);
    if (this.instance.type === 'compressor' || this.instance.type === 'limiter') {
      this.buildGrMeter(x, this.def.height - 16, w);
    }
    if (this.instance.type === 'visualizer') this.buildVisFace(x, y + 4, w);
    if (this.instance.type === 'composer') this.buildComposerFace(x, y + 4, w);
    if (this.instance.type === 'vcf') this.buildVcfFace(x, y, w);
    if (this.instance.type === 'knob') this.buildKnobFace();
    if (this.instance.type === 'slider') this.buildSliderFace();
    if (this.instance.type === 'xy') this.buildXyFace();
    if (this.instance.type === 'button') this.buildButtonFace();
  }

  // -- filter (vcf) face: knobs + response curve -----------------------------

  private vcfRedraws: Array<() => void> = [];
  private vcfCurveG: Graphics | null = null;
  private vcfCurveRect = { x: 0, y: 0, w: 0, h: 0 };

  /** Normalized 0–1 position of a param value, honoring its display curve. */
  private paramNorm(p: ParamSpec, v: number): number {
    if (p.curve === 'exp' && p.min > 0) return Math.log(v / p.min) / Math.log(p.max / p.min);
    return (v - p.min) / (p.max - p.min);
  }

  private paramFromNorm(p: ParamSpec, n: number): number {
    const k = Math.min(1, Math.max(0, n));
    if (p.curve === 'exp' && p.min > 0) return p.min * Math.pow(p.max / p.min, k);
    return p.min + k * (p.max - p.min);
  }

  /** Rotary knob for one param (PRD: filters get cutoff/Q knobs). */
  private buildMiniKnob(param: ParamSpec, cx: number, cy: number, r: number): void {
    const g = new Graphics();
    this.addChild(g);
    const value = new Text({ text: '', style: { fontSize: 10, fill: theme.text } });
    value.anchor.set(0.5, 0);
    value.position.set(cx, cy + r + 4);
    this.addChild(value);
    const label = new Text({ text: param.label, style: { fontSize: 10, fill: theme.textDim } });
    label.anchor.set(0.5, 1);
    label.position.set(cx, cy - r - 4);
    label.eventMode = 'none';
    this.addChild(label);

    const redraw = () => {
      const v = this.instance.params[param.id] ?? param.default;
      const n = Math.min(1, Math.max(0, this.paramNorm(param, v)));
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
      g.arc(cx, cy, r, a0, av).stroke({ width: 3, color: PORT_TYPE_COLORS.audio });
      g.moveTo(cx + Math.cos(av) * r * 0.25, cy + Math.sin(av) * r * 0.25)
        .lineTo(cx + Math.cos(av) * r * 0.66, cy + Math.sin(av) * r * 0.66)
        .stroke({ width: 2, color: theme.text });
      value.text = this.formatParam(param);
    };
    redraw();
    this.vcfRedraws.push(redraw);

    const hit = new Graphics().circle(cx, cy, r + 6).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'ns-resize';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      if (e.altKey) {
        appState.armMidiLearn(this.instance.id, param.id);
        return;
      }
      appState.beginUndoable();
      const start = this.paramNorm(param, this.instance.params[param.id] ?? param.default);
      const startY = e.clientY;
      const scale = this.worldTransform.a || 1;
      const onMove = (ev: PointerEvent) => {
        const n = start + (startY - ev.clientY) / scale / 120;
        appState.setParam(this.instance.id, param.id, this.paramFromNorm(param, n));
        this.refreshParams();
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    hit.on('pointerover', (ev) =>
      this.tooltip.show(
        [`${param.label}: ${this.formatParam(param)}`, 'Drag up/down. Alt-click: MIDI learn.'],
        ev.clientX,
        ev.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  private buildVcfFace(x: number, y: number, w: number): void {
    this.vcfRedraws = [];
    const spec = (id: string) => this.def.params.find((p) => p.id === id)!;
    this.buildParamRow(spec('mode'), x, y, w);
    const knobY = y + ROW_H + 44;
    this.buildMiniKnob(spec('cutoff'), x + w * 0.28, knobY, 24);
    this.buildMiniKnob(spec('res'), x + w * 0.72, knobY, 24);
    this.buildParamRow(spec('amt'), x, knobY + 44, w);

    const cy = knobY + 44 + ROW_H + 4;
    this.vcfCurveRect = { x, y: cy, w, h: this.def.height - cy - 12 };
    this.vcfCurveG = new Graphics();
    this.addChild(this.vcfCurveG);
    this.drawVcfCurve();

    const r = this.vcfCurveRect;
    const hit = new Graphics().rect(r.x, r.y, r.w, r.h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'crosshair';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.beginUndoable();
      const cutoff = spec('cutoff');
      const res = spec('res');
      const apply = (lx: number, ly: number) => {
        appState.setParam(this.instance.id, 'cutoff', this.paramFromNorm(cutoff, (lx - r.x) / r.w));
        appState.setParam(this.instance.id, 'res', this.paramFromNorm(res, 1 - (ly - r.y) / r.h));
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

  private ctrlSpec(id: string): ParamSpec {
    return this.def.params.find((p) => p.id === id)!;
  }

  private setCtrl(paramId: string, v: number): void {
    appState.setParam(this.instance.id, paramId, Math.min(1, Math.max(0, v)));
  }

  /** Relative drag shared by knob/slider/XY; one undo step per gesture. */
  private beginCtrlDrag(
    e: FederatedPointerEvent,
    apply: (dxLocal: number, dyLocal: number) => void,
    onDone?: () => void,
  ): void {
    appState.beginUndoable();
    const startX = e.clientX;
    const startY = e.clientY;
    // Client px → canvas-local px (canvas zoom lives in the world transform).
    const scale = this.worldTransform.a || 1;
    const onMove = (ev: PointerEvent) => {
      apply((ev.clientX - startX) / scale, (ev.clientY - startY) / scale);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      onDone?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** Double-click value entry (PRD §8.6 "double-click to type a value"). */
  private promptCtrl(paramId: string, redraw: () => void): void {
    const cur = this.instance.params[paramId] ?? 0;
    const raw = window.prompt(`${this.def.name} value (0–1)`, cur.toFixed(3));
    if (raw === null) return;
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    appState.beginUndoable();
    this.setCtrl(paramId, v);
    redraw();
  }

  private knobCenter(): { cx: number; cy: number } {
    return { cx: this.def.width / 2, cy: TITLE_H + 56 };
  }

  private buildKnobFace(): void {
    const { cx, cy } = this.knobCenter();
    this.ctrlG = new Graphics();
    this.addChild(this.ctrlG);
    this.ctrlText = new Text({ text: '', style: { fontSize: 12, fill: theme.text } });
    this.ctrlText.anchor.set(0.5, 0);
    this.ctrlText.position.set(cx, cy + 44);
    this.addChild(this.ctrlText);
    this.drawKnob();

    const hit = new Graphics().circle(cx, cy, 40).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'ns-resize';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      if (e.altKey) {
        appState.armMidiLearn(this.instance.id, 'value');
        return;
      }
      if (e.detail >= 2) {
        this.promptCtrl('value', () => this.drawKnob());
        return;
      }
      const start = this.instance.params.value ?? 0;
      this.beginCtrlDrag(e, (_dx, dy) => {
        this.setCtrl('value', start - dy / 120);
        this.drawKnob();
      });
    });
    hit.on('pointerover', (ev) =>
      this.tooltip.show(
        ['Knob: drag up/down. Double-click: type a value. Alt-click: MIDI learn.'],
        ev.clientX,
        ev.clientY,
      ),
    );
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
    g.arc(cx, cy, 36, a0, av).stroke({ width: 4, color: PORT_TYPE_COLORS.control });
    g.moveTo(cx + Math.cos(av) * 10, cy + Math.sin(av) * 10)
      .lineTo(cx + Math.cos(av) * 26, cy + Math.sin(av) * 26)
      .stroke({ width: 3, color: theme.text });
    if (this.ctrlText) this.ctrlText.text = v.toFixed(2);
  }

  private sliderTrack(): { x: number; y: number; w: number; h: number; horiz: boolean } {
    const horiz = Math.round(this.instance.params.orient ?? 0) === 1;
    const pad = 18;
    if (horiz) {
      return { x: pad, y: TITLE_H + 40, w: this.def.width - pad * 2, h: 12, horiz };
    }
    return { x: this.def.width / 2 - 6, y: TITLE_H + 14, w: 12, h: this.def.height - TITLE_H - 70, horiz };
  }

  private buildSliderFace(): void {
    this.ctrlG = new Graphics();
    this.addChild(this.ctrlG);
    this.ctrlText = new Text({ text: '', style: { fontSize: 12, fill: theme.text } });
    this.ctrlText.anchor.set(0.5, 0);
    this.ctrlText.position.set(this.def.width / 2, this.def.height - 48);
    this.addChild(this.ctrlText);
    this.drawSlider();

    // Hit area covers both orientations; drawing follows the orient param.
    const hit = new Graphics()
      .rect(8, TITLE_H + 6, this.def.width - 16, this.def.height - TITLE_H - 56)
      .fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      if (e.altKey) {
        appState.armMidiLearn(this.instance.id, 'value');
        return;
      }
      if (e.detail >= 2) {
        this.promptCtrl('value', () => this.drawSlider());
        return;
      }
      const t = this.sliderTrack();
      appState.beginUndoable();
      // Jump to the click position, then track relatively.
      const local = this.toLocal(e.global);
      this.setCtrl('value', t.horiz ? (local.x - t.x) / t.w : 1 - (local.y - t.y) / t.h);
      this.drawSlider();
      const start = this.instance.params.value ?? 0;
      this.beginCtrlDrag(e, (dx, dy) => {
        this.setCtrl('value', start + (t.horiz ? dx / t.w : -dy / t.h));
        this.drawSlider();
      });
    });
    hit.on('pointerover', (ev) =>
      this.tooltip.show(
        ['Slider: click or drag. Double-click: type a value. Alt-click: MIDI learn.'],
        ev.clientX,
        ev.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);

    this.buildParamRow(this.ctrlSpec('orient'), 18, this.def.height - 28, this.def.width - 36);
  }

  drawSlider(): void {
    if (!this.ctrlG || this.instance.type !== 'slider') return;
    const v = Math.min(1, Math.max(0, this.instance.params.value ?? 0));
    const t = this.sliderTrack();
    const g = this.ctrlG;
    g.clear();
    g.roundRect(t.x, t.y, t.w, t.h, 5).fill(theme.inset).stroke({ width: 1, color: theme.moduleStroke });
    if (t.horiz) {
      g.roundRect(t.x, t.y, t.w * v, t.h, 5).fill(PORT_TYPE_COLORS.control);
      g.roundRect(t.x + t.w * v - 7, t.y - 6, 14, t.h + 12, 4)
        .fill(theme.button)
        .stroke({ width: 1, color: theme.text });
    } else {
      g.roundRect(t.x, t.y + t.h * (1 - v), t.w, t.h * v, 5).fill(PORT_TYPE_COLORS.control);
      g.roundRect(t.x - 12, t.y + t.h * (1 - v) - 7, t.w + 24, 14, 4)
        .fill(theme.button)
        .stroke({ width: 1, color: theme.text });
    }
    if (this.ctrlText) this.ctrlText.text = v.toFixed(2);
  }

  private xyPad(): { x: number; y: number; w: number; h: number } {
    return {
      x: 18,
      y: TITLE_H + 8,
      w: this.def.width - 36,
      h: this.def.height - TITLE_H - 8 - 34,
    };
  }

  private buildXyFace(): void {
    this.ctrlG = new Graphics();
    this.addChild(this.ctrlG);
    this.drawXy();

    const r = this.xyPad();
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
      this.beginCtrlDrag(
        e,
        (dx, dy) => {
          this.setCtrl('x', sx + dx / r.w);
          this.setCtrl('y', sy - dy / r.h);
          this.drawXy();
        },
        () => {
          if (Math.round(this.instance.params.spring ?? 0) === 1) {
            this.setCtrl('x', 0.5);
            this.setCtrl('y', 0.5);
            this.drawXy();
          }
        },
      );
    });
    hit.on('pointerover', (ev) =>
      this.tooltip.show(['XY pad: drag the puck. X and Y are separate control outputs.'], ev.clientX, ev.clientY),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);

    this.buildParamRow(this.ctrlSpec('spring'), 18, this.def.height - 26, this.def.width - 36);
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
    g.circle(px, py, 9).fill(PORT_TYPE_COLORS.control).stroke({ width: 2, color: theme.text });
  }

  private buttonRect(): { x: number; y: number; w: number; h: number } {
    return { x: 22, y: TITLE_H + 10, w: this.def.width - 44, h: this.def.height - TITLE_H - 48 };
  }

  private buildButtonFace(): void {
    this.ctrlG = new Graphics();
    this.addChild(this.ctrlG);
    this.drawButton();

    const r = this.buttonRect();
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

    this.buildParamRow(this.ctrlSpec('mode'), 18, this.def.height - 28, this.def.width - 36);
  }

  drawButton(): void {
    if (!this.ctrlG || this.instance.type !== 'button') return;
    const r = this.buttonRect();
    const on = (this.instance.params.value ?? 0) > 0.5;
    const g = this.ctrlG;
    g.clear();
    g.roundRect(r.x, r.y, r.w, r.h, 10)
      .fill(on ? PORT_TYPE_COLORS.control : theme.button)
      .stroke({ width: 2, color: on ? theme.text : theme.moduleStroke });
  }

  // -- composer face (PRD §8.3, piano roll) --------------------------------------

  private compG: Graphics | null = null;
  private compRect = { x: 0, y: 0, w: 0, h: 0 };
  private lastCompPos = -1;
  private lastCompData: unknown = null;

  private buildComposerFace(x: number, y: number, w: number): void {
    const h = this.def.height - y - 46; // room for the open button below
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
        ['Composer clip', 'Preview of the piano-roll clip. Click to open the editor.'],
        e.clientX,
        e.clientY,
      ),
    );
    bg.on('pointerout', () => this.tooltip.hide());
    this.addChild(bg);
    this.compG = new Graphics();
    this.compG.eventMode = 'none';
    this.addChild(this.compG);

    const btnY = y + h + 8;
    const btn = new Graphics()
      .roundRect(x, btnY, w, 26, 4)
      .fill(theme.button)
      .stroke({ width: 1, color: theme.moduleStroke });
    btn.eventMode = 'static';
    btn.cursor = 'pointer';
    btn.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.openComposer(this.instance.id);
    });
    btn.on('pointerover', (e) =>
      this.tooltip.show(['Piano Roll', 'Open the full editor: notes, tools, MIDI import/export.'], e.clientX, e.clientY),
    );
    btn.on('pointerout', () => this.tooltip.hide());
    this.addChild(btn);
    const label = new Text({ text: 'Open Piano Roll ▸', style: { fontSize: 12, fill: theme.text } });
    label.anchor.set(0.5);
    label.position.set(x + w / 2, btnY + 13);
    label.eventMode = 'none';
    this.addChild(label);

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
  private visRect = { x: 0, y: 0, w: 0, h: 0 };
  private visParticles: Array<{ x: number; y: number; vx: number; vy: number; life: number; hue: number }> = [];

  private buildVisFace(x: number, y: number, w: number): void {
    const h = this.def.height - y - 12;
    this.visRect = { x, y, w, h };
    const bg = new Graphics().roundRect(x, y, w, h, 4).fill(0x0c0c12);
    this.addChild(bg);
    this.visG = new Graphics();
    this.visG.eventMode = 'none';
    this.addChild(this.visG);

    const big = new Text({ text: '⛶', style: { fontSize: 14, fill: theme.textDim } });
    big.anchor.set(1, 0);
    big.position.set(x + w - 4, y + 4);
    big.eventMode = 'static';
    big.cursor = 'pointer';
    big.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.openVisualizer(this.instance.id);
    });
    big.on('pointerover', (e) =>
      this.tooltip.show(['Big view', 'Opens the resizable visualizer window (fullscreen button inside).'], e.clientX, e.clientY),
    );
    big.on('pointerout', () => this.tooltip.hide());
    this.addChild(big);
  }

  /** Shared scene renderer — the overlay duplicates this on a 2D canvas. */
  private drawVisScene(): void {
    if (!this.visG) return;
    const data = appState.visData[this.instance.id];
    const { x, y, w, h } = this.visRect;
    const g = this.visG;
    const scene = Math.round(this.instance.params.scene ?? 0);
    const ctrl = data && data.ctrl >= 0 ? data.ctrl : 1;
    const gain = (this.instance.params.gain ?? 1.5) * (0.3 + 0.7 * ctrl);
    g.clear();
    if (!data) return;

    if (scene === 0) {
      // Oscilloscope.
      const mid = y + h / 2;
      data.wave.forEach((v, i) => {
        const px = x + (i / (data.wave.length - 1)) * w;
        const py = mid - Math.max(-1, Math.min(1, v * gain)) * (h / 2 - 4);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.stroke({ width: 1.5, color: 0x3dd9ff, alpha: 0.95 });
    } else if (scene === 1) {
      // Spectrum bars.
      const n = data.spectrum.length;
      const bw = w / n;
      for (let b = 0; b < n; b++) {
        const frac = Math.min(1, Math.max(0, (data.spectrum[b] + 80) / 80)) * Math.min(1, gain);
        if (frac <= 0.01) continue;
        g.roundRect(x + b * bw + 1, y + h - frac * (h - 6), bw - 2, frac * (h - 6), 1)
          .fill({ color: 0xffb13d, alpha: 0.9 });
      }
    } else {
      // Particles: notes spawn bursts, audio energy feeds drift speed.
      let energy = 0;
      for (const db of data.spectrum) energy = Math.max(energy, (db + 80) / 80);
      for (const pitch of data.notes) {
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
    const h = this.def.height - y - 14;
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

  // -- gain-reduction meter (compressor/limiter, PRD §8.4) ---------------------

  private grBar: Graphics | null = null;
  private grRect = { x: 0, y: 0, w: 0 };

  private buildGrMeter(x: number, y: number, w: number): void {
    const label = new Text({ text: 'GR', style: { fontSize: 9, fill: theme.textDim } });
    label.position.set(x, y - 1);
    this.addChild(label);
    const bg = new Graphics().roundRect(x + 20, y, w - 20, 8, 3).fill(theme.inset);
    this.addChild(bg);
    this.grBar = new Graphics();
    this.addChild(this.grBar);
    this.grRect = { x: x + 20, y, w: w - 20 };
  }

  // -- drum machine face -----------------------------------------------------

  private drumSel = 0;
  private drumPadsG: Graphics | null = null;
  private drumStepsG: Graphics | null = null;
  private drumPadLabels: Text[] = [];
  private drumNameText: Text | null = null;
  private drumRowTexts = new Map<string, Text>();
  private drumPadGridRect = { x: 0, y: 0, cell: 0, gap: 0 };
  private drumStepRect = { x: 0, y: 0, w: 0, h: 0 };
  private lastDrumStep = -1;

  private static readonly DRUM_PAD_FIELDS: Array<{
    id: string;
    label: string;
    min: number;
    max: number;
    options?: string[];
  }> = [
    { id: 'level', label: 'Level', min: 0, max: 1 },
    { id: 'pan', label: 'Pan', min: -1, max: 1 },
    { id: 'pitch', label: 'Pitch', min: -12, max: 12 },
    { id: 'choke', label: 'Choke', min: 0, max: 4, options: ['off', '1', '2', '3', '4'] },
    { id: 'attack', label: 'Attack', min: 0.0005, max: 0.1 },
    { id: 'decay', label: 'Decay', min: 0.02, max: DRUM_DECAY_MAX },
  ];

  private drumPads(): DrumPad[] {
    return (this.instance.data?.pads as DrumPad[]) ?? [];
  }

  private drumPattern(): DrumStep[][] {
    return (this.instance.data?.pattern as DrumStep[][]) ?? [];
  }

  private buildDrumFace(x: number, y: number, w: number): void {
    const cell = 35;
    const gap = 3;
    const gridSize = 4 * cell + 3 * gap;
    this.drumPadGridRect = { x, y, cell, gap };

    this.drumPadsG = new Graphics();
    this.addChild(this.drumPadsG);
    for (let i = 0; i < DRUM_PADS; i++) {
      const t = new Text({ text: '', style: { fontSize: 8, fill: theme.text } });
      t.anchor.set(0.5);
      t.position.set(
        x + (i % 4) * (cell + gap) + cell / 2,
        y + Math.floor(i / 4) * (cell + gap) + cell / 2,
      );
      t.eventMode = 'none';
      this.addChild(t);
      this.drumPadLabels.push(t);
    }
    const padHit = new Graphics().rect(x, y, gridSize, gridSize).fill({ color: 0xffffff, alpha: 0.001 });
    padHit.eventMode = 'static';
    padHit.cursor = 'pointer';
    padHit.on('pointerdown', (e) => {
      e.stopPropagation();
      const local = this.toLocal(e.global);
      const col = Math.min(3, Math.max(0, Math.floor((local.x - x) / (cell + gap))));
      const row = Math.min(3, Math.max(0, Math.floor((local.y - y) / (cell + gap))));
      this.drumSel = row * 4 + col;
      appState.padTrigger(this.instance.id, this.drumSel);
      this.refreshDrumFace();
    });
    padHit.on('pointerover', (e) =>
      this.tooltip.show(['Pads', 'Click: select + audition. Steps and pad controls follow the selected pad.'], e.clientX, e.clientY),
    );
    padHit.on('pointerout', () => this.tooltip.hide());
    this.addChild(padHit);

    // Right column: selected pad name (click to load a sample) + pad controls.
    const colX = x + gridSize + 8;
    const colW = w - gridSize - 8;
    this.drumNameText = new Text({ text: '', style: { fontSize: 11, fill: theme.text, fontWeight: 'bold' } });
    this.drumNameText.position.set(colX, y);
    this.addChild(this.drumNameText);
    const loadHit = new Graphics().rect(colX - 2, y - 2, colW + 4, 18).fill({ color: 0xffffff, alpha: 0.001 });
    loadHit.eventMode = 'static';
    loadHit.cursor = 'pointer';
    loadHit.on('pointerdown', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void appState.loadSampleFile(this.instance.id, file, this.drumSel);
      };
      input.click();
    });
    loadHit.on('pointerover', (e) =>
      this.tooltip.show(['Pad sample', 'Click to load an audio file onto the selected pad.'], e.clientX, e.clientY),
    );
    loadHit.on('pointerout', () => this.tooltip.hide());
    this.addChild(loadHit);

    // ✎ opens the Sample Editor for the selected pad (sits above loadHit).
    const editBtn = new Text({ text: '✎', style: { fontSize: 12, fill: theme.textDim } });
    editBtn.anchor.set(1, 0);
    editBtn.position.set(colX + colW, y);
    editBtn.eventMode = 'static';
    editBtn.cursor = 'pointer';
    editBtn.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.openSampleEditor(this.instance.id, this.drumSel);
    });
    editBtn.on('pointerover', (e) =>
      this.tooltip.show(['Sample Editor', 'Edit the selected pad: trim, normalize, fades…'], e.clientX, e.clientY),
    );
    editBtn.on('pointerout', () => this.tooltip.hide());
    this.addChild(editBtn);

    let rowY = y + 22;
    for (const field of ModuleView.DRUM_PAD_FIELDS) {
      this.buildDrumPadRow(field, colX, rowY, colW);
      rowY += ROW_H;
    }

    // Step row for the selected pad.
    const stepY = y + gridSize + 6;
    this.drumStepRect = { x, y: stepY, w, h: 32 };
    this.drumStepsG = new Graphics();
    this.addChild(this.drumStepsG);
    const stepHit = new Graphics().rect(x, stepY, w, 32).fill({ color: 0xffffff, alpha: 0.001 });
    stepHit.eventMode = 'static';
    stepHit.cursor = 'pointer';
    stepHit.on('pointerdown', (e) => {
      e.stopPropagation();
      this.beginDrumStepEdit(e);
    });
    stepHit.on('pointerover', (e) =>
      this.tooltip.show(['Steps (selected pad)', 'Click: toggle step. Drag up/down: set velocity.'], e.clientX, e.clientY),
    );
    stepHit.on('pointerout', () => this.tooltip.hide());
    this.addChild(stepHit);

    this.refreshDrumFace();
  }

  private buildDrumPadRow(
    field: { id: string; label: string; min: number; max: number; options?: string[] },
    x: number,
    y: number,
    w: number,
  ): void {
    const label = new Text({ text: field.label, style: { fontSize: 11, fill: theme.textDim } });
    label.position.set(x, y + 3);
    this.addChild(label);

    const value = new Text({ text: '', style: { fontSize: 11, fill: theme.text } });
    value.anchor.set(1, 0);
    value.position.set(x + w, y + 3);
    this.addChild(value);
    this.drumRowTexts.set(field.id, value);

    const hit = new Graphics().rect(x - 4, y, w + 8, ROW_H).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'ew-resize';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      this.beginDrumPadRowDrag(field, e);
    });
    hit.on('pointerover', (e) =>
      this.tooltip.show(
        [`${field.label}: ${this.formatDrumField(field)}`,
          field.options ? 'Click to cycle' : `Drag to change (${field.min}–${field.max})`],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  private drumFieldValue(id: string): number {
    const pad = this.drumPads()[this.drumSel] as unknown as Record<string, number> | undefined;
    return pad?.[id] ?? 0;
  }

  private commitDrumField(id: string, v: number): void {
    const pads = [...this.drumPads()];
    const cur = pads[this.drumSel];
    if (!cur) return;
    pads[this.drumSel] = { ...cur, [id]: v };
    appState.setModuleData(this.instance.id, 'pads', pads);
  }

  private beginDrumPadRowDrag(
    field: { id: string; label: string; min: number; max: number; options?: string[] },
    e: FederatedPointerEvent,
  ): void {
    appState.beginUndoable();
    const startX = e.clientX;
    const startValue = this.drumFieldValue(field.id);
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      if (field.options) return;
      const range = field.max - field.min;
      let v = startValue + (dx / 150) * range;
      v = Math.min(field.max, Math.max(field.min, v));
      if (field.id === 'pitch') v = Math.round(v);
      this.commitDrumField(field.id, v);
      this.updateDrumRowText(field);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved && field.options) {
        const next = (Math.round(this.drumFieldValue(field.id)) + 1) % field.options.length;
        this.commitDrumField(field.id, next);
        this.updateDrumRowText(field);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private formatDrumField(field: { id: string; min: number; max: number; options?: string[] }): string {
    const v = this.drumFieldValue(field.id);
    if (field.options) return field.options[Math.round(v)] ?? String(v);
    if (field.id === 'pitch') return `${v > 0 ? '+' : ''}${Math.round(v)} st`;
    if (field.id === 'decay' && v >= DRUM_DECAY_MAX) return 'full';
    return Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  }

  private updateDrumRowText(field: { id: string; min: number; max: number; options?: string[] }): void {
    const t = this.drumRowTexts.get(field.id);
    if (t) t.text = this.formatDrumField(field);
  }

  private beginDrumStepEdit(e: FederatedPointerEvent): void {
    const pattern = this.drumPattern();
    const row = pattern[this.drumSel];
    if (!row || row.length === 0) return;
    appState.beginUndoable();
    const local = this.toLocal(e.global);
    const { x, w } = this.drumStepRect;
    const idx = Math.min(row.length - 1, Math.max(0, Math.floor(((local.x - x) / w) * row.length)));
    const step = row[idx];
    const startY = e.clientY;
    const startVel = step.vel;
    let moved = false;

    const commit = () => {
      appState.setModuleData(this.instance.id, 'pattern', [...pattern]);
      this.drawDrumSteps(this.lastDrumStep);
    };
    const onMove = (ev: PointerEvent) => {
      const dy = startY - ev.clientY;
      if (Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      step.on = true;
      step.vel = Math.min(1, Math.max(0.05, startVel + dy / 60));
      this.tooltip.showNow([`vel ${Math.round(step.vel * 100)}%`], ev.clientX, ev.clientY);
      commit();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.tooltip.hide();
      if (!moved) {
        step.on = !step.on;
        commit();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private drawDrumPads(): void {
    if (!this.drumPadsG) return;
    const { x, y, cell, gap } = this.drumPadGridRect;
    const pads = this.drumPads();
    const g = this.drumPadsG;
    g.clear();
    for (let i = 0; i < DRUM_PADS; i++) {
      const cx = x + (i % 4) * (cell + gap);
      const cy = y + Math.floor(i / 4) * (cell + gap);
      const loaded = appState.samples.has(sampleKey(this.instance.id, i));
      const selected = i === this.drumSel;
      g.roundRect(cx, cy, cell, cell, 4)
        .fill(loaded ? theme.button : theme.inset)
        .stroke({ width: selected ? 2 : 1, color: selected ? theme.selectedStroke : theme.moduleStroke });
      const label = this.drumPadLabels[i];
      if (label) {
        label.text = pads[i]?.name?.slice(0, 5) ?? '';
        label.style.fill = loaded ? theme.text : theme.textDim;
      }
    }
  }

  private drawDrumSteps(playhead = -1): void {
    if (!this.drumStepsG) return;
    const { x, y, w, h } = this.drumStepRect;
    const row = this.drumPattern()[this.drumSel] ?? [];
    if (row.length === 0) return;
    const cellW = w / row.length;
    const g = this.drumStepsG;
    g.clear();
    for (let i = 0; i < row.length; i++) {
      const cx = x + i * cellW;
      g.roundRect(cx + 1, y, cellW - 2, h, 2).fill(theme.inset);
      if (i % 4 === 0) {
        g.rect(cx + 1, y, 2, h).fill({ color: 0xffffff, alpha: 0.08 });
      }
      if (i === playhead) {
        g.roundRect(cx + 1, y, cellW - 2, h, 2).fill({ color: 0xffffff, alpha: 0.12 });
      }
      const step = row[i];
      if (step?.on) {
        const barH = 4 + step.vel * (h - 8);
        g.roundRect(cx + 2, y + h - barH - 2, cellW - 4, barH, 2)
          .fill(i === playhead ? 0x7fe9ff : 0x3dd9ff);
      }
    }
  }

  /** Drum pad index at module-local coords (sample-library drops), else null. */
  padIndexAt(localX: number, localY: number): number | null {
    if (this.instance.type !== 'drum' || !this.drumPadsG) return null;
    const { x, y, cell, gap } = this.drumPadGridRect;
    const pitch = cell + gap;
    const col = Math.floor((localX - x) / pitch);
    const row = Math.floor((localY - y) / pitch);
    if (col < 0 || col > 3 || row < 0 || row > 3) return null;
    if (localX - x - col * pitch > cell || localY - y - row * pitch > cell) return null; // in the gap
    return row * 4 + col;
  }

  /** Currently selected drum pad (drop fallback when not over the grid). */
  get selectedPad(): number {
    return this.drumSel;
  }

  private refreshDrumFace(): void {
    if (!this.drumPadsG) return;
    this.drawDrumPads();
    this.drawDrumSteps(this.lastDrumStep);
    if (this.drumNameText) {
      const pad = this.drumPads()[this.drumSel];
      this.drumNameText.text = `${this.drumSel + 1}: ${pad?.name ?? ''}`;
    }
    for (const field of ModuleView.DRUM_PAD_FIELDS) this.updateDrumRowText(field);
  }

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
    this.recElapsed.anchor.set(1, 0);
    this.recElapsed.position.set(x + w, y + 8);
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
    const h = this.def.height - y - 28;
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
    if (this.drumPadsG) this.refreshDrumFace();
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

  private buildStepGrid(x: number, y: number, w: number): void {
    const h = this.def.height - y - 12;
    this.stepGridRect = { x, y, w, h };
    this.stepGrid = new Graphics();
    this.addChild(this.stepGrid);
    this.drawStepGrid();

    const hit = new Graphics().rect(x, y, w, h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      this.beginStepEdit(e);
    });
    hit.on('pointerover', (e) =>
      this.tooltip.show(['Steps', 'Click: toggle step. Drag up/down: set pitch.'], e.clientX, e.clientY),
    );
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  private stepIndexAt(localX: number): number {
    const { x, w } = this.stepGridRect;
    const steps = this.steps();
    return Math.min(steps.length - 1, Math.max(0, Math.floor(((localX - x) / w) * steps.length)));
  }

  private beginStepEdit(e: FederatedPointerEvent): void {
    appState.beginUndoable();
    const local = this.toLocal(e.global);
    const steps = this.steps();
    const idx = this.stepIndexAt(local.x);
    const step = steps[idx];
    if (!step) return;
    const startY = e.clientY;
    const startPitch = step.pitch;
    let moved = false;

    const commit = () => {
      appState.setModuleData(this.instance.id, 'steps', [...steps]);
      this.drawStepGrid();
    };
    const onMove = (ev: PointerEvent) => {
      const dy = startY - ev.clientY;
      if (Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      step.on = true;
      step.pitch = Math.round(
        Math.min(SEQ_PITCH_MAX, Math.max(SEQ_PITCH_MIN, startPitch + dy / 4)),
      );
      this.tooltip.showNow([noteName(step.pitch)], ev.clientX, ev.clientY);
      commit();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.tooltip.hide();
      if (!moved) {
        step.on = !step.on;
        commit();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private drawStepGrid(playhead = -1): void {
    if (!this.stepGrid) return;
    const { x, y, w, h } = this.stepGridRect;
    const steps = this.steps();
    if (steps.length === 0) return;
    const cellW = w / steps.length;
    const g = this.stepGrid;
    g.clear();
    for (let i = 0; i < steps.length; i++) {
      const cx = x + i * cellW;
      const isBeat = i % 4 === 0;
      g.roundRect(cx + 1, y, cellW - 2, h, 2).fill(theme.inset);
      if (i === playhead) {
        g.roundRect(cx + 1, y, cellW - 2, h, 2).fill({ color: 0xffffff, alpha: 0.12 });
      }
      const step = steps[i];
      if (step.on) {
        const norm = (step.pitch - SEQ_PITCH_MIN) / (SEQ_PITCH_MAX - SEQ_PITCH_MIN);
        const barH = 4 + norm * (h - 8);
        g.roundRect(cx + 2, y + h - barH - 2, cellW - 4, barH, 2)
          .fill(i === playhead ? 0x7fe9ff : 0x3dd9ff);
      }
    }
  }

  private buildParamRow(param: ParamSpec, x: number, y: number, w: number): void {
    const label = new Text({ text: param.label, style: { fontSize: 11, fill: theme.textDim } });
    label.position.set(x, y + 3);
    this.addChild(label);

    const value = new Text({
      text: this.formatParam(param),
      style: { fontSize: 11, fill: theme.text },
    });
    value.anchor.set(1, 0);
    value.position.set(x + w, y + 3);
    this.addChild(value);
    this.paramTexts.set(param.id, value);

    const hit = new Graphics().rect(x - 4, y, w + 8, ROW_H).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'ew-resize';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      if (e.altKey) {
        // MIDI learn (PRD Phase 2): alt-click a param, then move a hardware CC.
        appState.armMidiLearn(this.instance.id, param.id);
        return;
      }
      this.beginParamDrag(param, e);
    });
    hit.on('pointerover', (e) => {
      this.tooltip.show(
        [`${param.label}: ${this.formatParam(param)}`,
          (param.options ? 'Click to cycle' : `Drag to change (${param.min}–${param.max}${param.unit ?? ''})`) +
            '. Alt-click: MIDI learn.'],
        e.clientX,
        e.clientY,
      );
    });
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  private beginParamDrag(param: ParamSpec, e: FederatedPointerEvent): void {
    // Face-learn (PRD §6 macro controls): armed editor captures this param.
    if (appState.faceLearn && appState.completeFaceLearn(this.instance.id, param.id)) return;
    appState.beginUndoable(); // whole drag (or option cycle) = one undo step
    const startX = e.clientX;
    const startValue = this.instance.params[param.id];
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      if (param.options) return; // options cycle on click, not drag
      const range = param.max - param.min;
      let v = startValue + (dx / 150) * range;
      v = Math.min(param.max, Math.max(param.min, v));
      appState.setParam(this.instance.id, param.id, v);
      this.updateParamText(param);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved && param.options) {
        const next = (Math.round(this.instance.params[param.id]) + 1) % param.options.length;
        appState.setParam(this.instance.id, param.id, next);
        this.updateParamText(param);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private formatParam(param: ParamSpec): string {
    const v = this.instance.params[param.id];
    if (param.options) return param.options[Math.round(v)] ?? String(v);
    const text = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
    return param.unit ? `${text} ${param.unit}` : text;
  }

  private updateParamText(param: ParamSpec): void {
    const t = this.paramTexts.get(param.id);
    if (t) t.text = this.formatParam(param);
  }

  refreshParams(): void {
    for (const p of this.def.params) this.updateParamText(p);
    if (this.instance.type === 'peq') this.drawPeqCurve();
    if (this.instance.type === 'vcf') {
      for (const fn of this.vcfRedraws) fn();
      this.drawVcfCurve();
    }
    if (this.instance.type === 'knob') this.drawKnob();
    if (this.instance.type === 'slider') this.drawSlider();
    if (this.instance.type === 'xy') this.drawXy();
    if (this.instance.type === 'button') this.drawButton();
  }

  // -- type-specific faces --------------------------------------------------

  private buildKeys(x: number, y: number, w: number): void {
    const keyW = w / KEYS.length;
    const keyH = this.def.height - y - 10;
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

  private buildMeter(x: number, y: number, w: number): void {
    const bg = new Graphics().roundRect(x, y, w, 8, 3).fill(theme.inset);
    this.addChild(bg);
    this.meterBar = new Graphics();
    this.addChild(this.meterBar);
    this.clipDot = new Graphics();
    this.clipDot.circle(x + w + 8, y + 4, 4).fill(0x550000);
    this.clipDot.eventMode = 'static';
    this.clipDot.cursor = 'pointer';
    this.addChild(this.clipDot);
    this.meterX = x;
    this.meterY = y;
    this.meterW = w;
  }

  private meterX = 0;
  private meterY = 0;
  private meterW = 0;
  private clipped = false;

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
      // Gain reduction grows right-to-left, red, scaled to 24 dB full width.
      const gr = appState.gainReduction[this.instance.id] ?? 0;
      const w = Math.min(1, gr / 24) * this.grRect.w;
      this.grBar.clear();
      if (w > 0.5) {
        this.grBar
          .roundRect(this.grRect.x + this.grRect.w - w, this.grRect.y, w, 8, 3)
          .fill(0xff5050);
      }
    }
    if (this.drumStepsG) {
      const step = appState.seqSteps[this.instance.id] ?? -1;
      const current = appState.transport.playing ? step : -1;
      if (current !== this.lastDrumStep) {
        this.lastDrumStep = current;
        this.drawDrumSteps(current);
      }
    }
    if (!this.meterBar) return;
    const reading = appState.meters[this.instance.id];
    const peak = reading?.peak ?? 0;
    if (reading?.clipped) this.clipped = true;
    this.meterBar.clear();
    const w = Math.min(1, peak) * this.meterW;
    if (w > 0.5) {
      this.meterBar
        .roundRect(this.meterX, this.meterY, w, 8, 3)
        .fill(peak > 1 ? 0xff3030 : peak > 0.85 ? 0xffb13d : 0x52e07a);
    }
    if (this.clipDot) {
      this.clipDot.clear().circle(this.meterX + this.meterW + 8, this.meterY + 4, 4)
        .fill(this.clipped ? 0xff2020 : 0x550000);
      this.clipDot.off('pointerdown');
      this.clipDot.on('pointerdown', (e) => {
        e.stopPropagation();
        this.clipped = false;
      });
    }
  }

  setSelected(on: boolean): void {
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
