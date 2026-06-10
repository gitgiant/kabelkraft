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
  SEQ_PITCH_MAX,
  SEQ_PITCH_MIN,
  WAVEFORMS,
  type SeqStep,
} from '../core/registry';
import { appState } from '../state';
import type { Tooltip } from './Tooltip';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteName(pitch: number): string {
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

export const PORT_RADIUS = 7;
const TITLE_H = 24;
const ROW_H = 20;
const BODY_COLOR = 0x26262e;
const BODY_SELECTED = 0x32323e;
const TITLE_COLOR = 0x33333d;
const TEXT_COLOR = 0xd8d8e0;
const DIM_TEXT = 0x9090a0;

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
      .fill(selected ? BODY_SELECTED : BODY_COLOR)
      .stroke({ width: selected ? 2 : 1, color: selected ? 0xffffff : 0x4a4a58 });
    this.body.roundRect(0, 0, w, TITLE_H, 8).fill(TITLE_COLOR);
    this.body.rect(0, TITLE_H - 8, w, 8).fill(TITLE_COLOR);
    if (this.instance.color !== undefined) {
      this.body.rect(0, TITLE_H, w, 3).fill(this.instance.color);
    }
  }

  private buildTitle(): void {
    const title = new Text({
      text: this.instance.label ?? this.def.name,
      style: { fontSize: 12, fill: TEXT_COLOR, fontWeight: 'bold' },
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

  private buildFace(): void {
    let y = TITLE_H + 8;
    const x = 18;
    const w = this.def.width - 36;

    for (const param of this.def.params) {
      this.buildParamRow(param, x, y, w);
      y += ROW_H;
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

    this.recLabel = new Text({ text: '', style: { fontSize: 12, fill: TEXT_COLOR, fontWeight: 'bold' } });
    this.recLabel.anchor.set(0.5);
    this.recLabel.position.set(x + 45, y + 15);
    this.recLabel.eventMode = 'none';
    this.addChild(this.recLabel);

    this.recElapsed = new Text({ text: '0.0 s', style: { fontSize: 12, fill: DIM_TEXT } });
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
      .fill(recording ? 0xaa2020 : 0x3a3a48)
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
      style: { fontSize: 10, fill: DIM_TEXT },
    });
    this.sampleNameText.position.set(x, y + h + 6);
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
    if (!this.waveform) return;
    const { x, y, w, h } = this.waveRect;
    const g = this.waveform;
    g.clear();
    g.roundRect(x, y, w, h, 4).fill(0x16161c);
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
      g.roundRect(cx + 1, y, cellW - 2, h, 2).fill(isBeat ? 0x20202a : 0x1c1c24);
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
    const label = new Text({ text: param.label, style: { fontSize: 11, fill: DIM_TEXT } });
    label.position.set(x, y + 3);
    this.addChild(label);

    const value = new Text({
      text: this.formatParam(param),
      style: { fontSize: 11, fill: TEXT_COLOR },
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
      this.beginParamDrag(param, e);
    });
    hit.on('pointerover', (e) => {
      const mod = appState.graph.modules.get(this.instance.id);
      this.tooltip.show(
        [`${param.label}: ${this.formatParam(param)}`,
          param.options ? 'Click to cycle' : `Drag to change (${param.min}–${param.max}${param.unit ?? ''})`],
        e.clientX,
        e.clientY,
      );
      void mod;
    });
    hit.on('pointerout', () => this.tooltip.hide());
    this.addChild(hit);
  }

  private beginParamDrag(param: ParamSpec, e: FederatedPointerEvent): void {
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
      const g = new Graphics().roundRect(0, 0, 36, 26, 5).fill(0x3a3a48);
      g.position.set(x + i * 42, y);
      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.on('pointerdown', (e) => {
        e.stopPropagation();
        appState.transportCommand(cmd);
      });
      this.addChild(g);
      const t = new Text({ text: icon, style: { fontSize: 13, fill: TEXT_COLOR } });
      t.anchor.set(0.5);
      t.position.set(x + i * 42 + 18, y + 13);
      t.eventMode = 'none';
      this.addChild(t);
    });
  }

  private buildMeter(x: number, y: number, w: number): void {
    const bg = new Graphics().roundRect(x, y, w, 8, 3).fill(0x16161c);
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
