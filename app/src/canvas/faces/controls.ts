import { Graphics, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { CTRL_HINT, MODULE_TITLE_H as T, type CtrlSpec, type ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/* Controller modules (PRD §8.6): Knob, Slider, XY pad, Button. They share a
 * normalized 0–1 Control output with a display-only configured range. */

/** Display range for Knob/Slider modules (instance.data.cfg). */
function ctrlCfg(view: ModuleView): { min: number; max: number; def: number } {
  const c = (view.instance.data?.cfg ?? {}) as Record<string, unknown>;
  const min = typeof c.min === 'number' && Number.isFinite(c.min) ? c.min : 0;
  let max = typeof c.max === 'number' && Number.isFinite(c.max) ? c.max : 1;
  if (max === min) max = min + 1;
  const def = typeof c.def === 'number' && Number.isFinite(c.def) ? c.def : min + 0.5 * (max - min);
  return { min, max, def: Math.min(max, Math.max(min, def)) };
}

function setCtrl(view: ModuleView, paramId: string, v: number): void {
  appState.setParam(view.instance.id, paramId, Math.min(1, Math.max(0, v)));
}

/** The Knob/Slider value as a CtrlSpec in the configured display range. */
function ctrlValueSpec(view: ModuleView, redraw: () => void): CtrlSpec {
  const cfg = ctrlCfg(view);
  return {
    key: 'value',
    label: view.instance.label ?? view.def.name,
    min: cfg.min,
    max: cfg.max,
    default: cfg.def,
    get: () => cfg.min + Math.min(1, Math.max(0, view.instance.params.value ?? 0)) * (cfg.max - cfg.min),
    set: (s) => {
      setCtrl(view, 'value', (s - cfg.min) / (cfg.max - cfg.min));
      redraw();
    },
    learnId: 'value',
  };
}

function ctrlScaledText(view: ModuleView): string {
  const cfg = ctrlCfg(view);
  const v = cfg.min + Math.min(1, Math.max(0, view.instance.params.value ?? 0)) * (cfg.max - cfg.min);
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** ⚙ opens the range-config popup (Knob/Slider modules). */
function buildConfigButton(view: ModuleView): void {
  const gear = new Text({ text: '⚙', style: { fontSize: 13, fill: theme.textDim } });
  gear.anchor.set(1, 0);
  gear.position.set(view.w - 6, T + 4);
  gear.eventMode = 'static';
  gear.cursor = 'pointer';
  gear.on('pointerdown', (e) => {
    e.stopPropagation();
    appState.openRangeConfig(view.instance.id);
  });
  gear.on('pointerover', (e) =>
    view.tooltip.show(['Range', 'Configure min, max and default. Display only — the output stays 0–1.'], e.clientX, e.clientY),
  );
  gear.on('pointerout', () => view.tooltip.hide());
  view.addChild(gear);
}

export class KnobFace implements FaceRenderer {
  private g: Graphics | null = null;
  private text: Text | null = null;

  private center(view: ModuleView): { cx: number; cy: number } {
    return { cx: view.w / 2, cy: T + 56 };
  }

  build(view: ModuleView): void {
    const { cx, cy } = this.center(view);
    view.setParamAnchor('value', cx, cy);
    this.g = new Graphics();
    view.addChild(this.g);
    this.text = new Text({ text: '', style: { fontSize: 12, fill: theme.text } });
    this.text.anchor.set(0.5, 0);
    this.text.position.set(cx, cy + 44);
    view.addChild(this.text);
    this.refresh(view);
    buildConfigButton(view);

    const hit = new Graphics().circle(cx, cy, 40).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'ns-resize';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const c = ctrlValueSpec(view, () => this.refresh(view));
      if (view.ctrlPreamble(c, e)) return;
      appState.beginUndoable();
      const start = view.instance.params.value ?? 0;
      const startY = e.clientY;
      const scale = view.worldTransform.a || 1;
      const onMove = (ev: PointerEvent) => {
        setCtrl(view, 'value', start + (startY - ev.clientY) / scale / 120);
        this.refresh(view);
        view.tooltip.showNow([view.ctrlTipTitle(c)], ev.clientX, ev.clientY);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        view.tooltip.hide();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    hit.on('pointerover', (ev) => {
      const c = ctrlValueSpec(view, () => this.refresh(view));
      view.tooltip.show([view.ctrlTipTitle(c), `${CTRL_HINT} ⚙: range.`], ev.clientX, ev.clientY);
    });
    hit.on('pointerout', () => view.tooltip.hide());
    view.addChild(hit);
  }

  refresh(view: ModuleView): void {
    if (!this.g) return;
    const { cx, cy } = this.center(view);
    const v = Math.min(1, Math.max(0, view.instance.params.value ?? 0));
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    const av = a0 + (a1 - a0) * v;
    const g = this.g;
    g.clear();
    g.circle(cx, cy, 28).fill(theme.inset).stroke({ width: 1, color: theme.moduleStroke });
    // moveTo before each arc: without it the path connects from its
    // current point (the graphics origin), drawing stray wire-like lines.
    g.moveTo(cx + Math.cos(a0) * 36, cy + Math.sin(a0) * 36);
    g.arc(cx, cy, 36, a0, a1).stroke({ width: 4, color: theme.inset });
    g.moveTo(cx + Math.cos(a0) * 36, cy + Math.sin(a0) * 36);
    g.arc(cx, cy, 36, a0, av).stroke({ width: 4, color: view.accent() });
    g.moveTo(cx + Math.cos(av) * 10, cy + Math.sin(av) * 10)
      .lineTo(cx + Math.cos(av) * 26, cy + Math.sin(av) * 26)
      .stroke({ width: 3, color: view.accent() });
    if (this.text) this.text.text = ctrlScaledText(view);
  }
}

export class SliderFace implements FaceRenderer {
  private g: Graphics | null = null;
  private text: Text | null = null;

  private track(view: ModuleView): { x: number; y: number; w: number; h: number; horiz: boolean } {
    const horiz = Math.round(view.instance.params.orient ?? 0) === 1;
    const pad = 18;
    if (horiz) {
      return { x: pad, y: T + 40, w: view.w - pad * 2, h: 12, horiz };
    }
    return { x: view.w / 2 - 6, y: T + 14, w: 12, h: view.h - T - 112, horiz };
  }

  build(view: ModuleView): void {
    this.g = new Graphics();
    view.addChild(this.g);
    this.text = new Text({ text: '', style: { fontSize: 12, fill: theme.text } });
    this.text.anchor.set(0.5, 0);
    this.text.position.set(view.w / 2, view.h - 90);
    view.addChild(this.text);
    this.refresh(view);
    buildConfigButton(view);
    const t0 = this.track(view);
    view.setParamAnchor('value', t0.x + t0.w / 2, t0.y + t0.h / 2);

    // Hit area covers both orientations; drawing follows the orient param.
    const hit = new Graphics()
      .rect(8, T + 6, view.w - 16, view.h - T - 98)
      .fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const c = ctrlValueSpec(view, () => this.refresh(view));
      if (view.ctrlPreamble(c, e)) return;
      const t = this.track(view);
      appState.beginUndoable();
      // Jump to the click position, then track relatively.
      const local = view.toLocal(e.global);
      setCtrl(view, 'value', t.horiz ? (local.x - t.x) / t.w : 1 - (local.y - t.y) / t.h);
      this.refresh(view);
      const start = view.instance.params.value ?? 0;
      const startX = e.clientX;
      const startY = e.clientY;
      const scale = view.worldTransform.a || 1;
      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / scale;
        const dy = (ev.clientY - startY) / scale;
        setCtrl(view, 'value', start + (t.horiz ? dx / t.w : -dy / t.h));
        this.refresh(view);
        view.tooltip.showNow([view.ctrlTipTitle(c)], ev.clientX, ev.clientY);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        view.tooltip.hide();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    hit.on('pointerover', (ev) => {
      const c = ctrlValueSpec(view, () => this.refresh(view));
      view.tooltip.show([view.ctrlTipTitle(c), `${CTRL_HINT} ⚙: range.`], ev.clientX, ev.clientY);
    });
    hit.on('pointerout', () => view.tooltip.hide());
    view.addChild(hit);

    view.buildSelector(view.paramCtrl(view.paramSpec('orient')), view.w / 2, view.h - 42, 12);
  }

  refresh(view: ModuleView): void {
    if (!this.g) return;
    const v = Math.min(1, Math.max(0, view.instance.params.value ?? 0));
    const t = this.track(view);
    const g = this.g;
    g.clear();
    g.roundRect(t.x, t.y, t.w, t.h, 5).fill(theme.inset).stroke({ width: 1, color: theme.moduleStroke });
    if (t.horiz) {
      g.roundRect(t.x, t.y, t.w * v, t.h, 5).fill(view.accent());
      g.roundRect(t.x + t.w * v - 7, t.y - 6, 14, t.h + 12, 4)
        .fill(theme.button)
        .stroke({ width: 1, color: theme.text });
    } else {
      g.roundRect(t.x, t.y + t.h * (1 - v), t.w, t.h * v, 5).fill(view.accent());
      g.roundRect(t.x - 12, t.y + t.h * (1 - v) - 7, t.w + 24, 14, 4)
        .fill(theme.button)
        .stroke({ width: 1, color: theme.text });
    }
    if (this.text) this.text.text = ctrlScaledText(view);
  }
}

export class XyFace implements FaceRenderer {
  private g: Graphics | null = null;

  private pad(view: ModuleView): { x: number; y: number; w: number; h: number } {
    return { x: 18, y: T + 8, w: view.w - 36, h: view.h - T - 8 - 58 };
  }

  build(view: ModuleView): void {
    this.g = new Graphics();
    view.addChild(this.g);
    this.refresh(view);

    const r = this.pad(view);
    view.setParamAnchor('x', r.x + r.w / 2, r.y + r.h / 2);
    view.setParamAnchor('y', r.x + r.w / 2, r.y + r.h / 2);
    const hit = new Graphics().rect(r.x, r.y, r.w, r.h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'crosshair';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.beginUndoable();
      const local = view.toLocal(e.global);
      setCtrl(view, 'x', (local.x - r.x) / r.w);
      setCtrl(view, 'y', 1 - (local.y - r.y) / r.h);
      this.refresh(view);
      const sx = view.instance.params.x ?? 0.5;
      const sy = view.instance.params.y ?? 0.5;
      const startX = e.clientX;
      const startY = e.clientY;
      const scale = view.worldTransform.a || 1;
      const onMove = (ev: PointerEvent) => {
        setCtrl(view, 'x', sx + (ev.clientX - startX) / scale / r.w);
        setCtrl(view, 'y', sy - (ev.clientY - startY) / scale / r.h);
        this.refresh(view);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (Math.round(view.instance.params.spring ?? 0) === 1) {
          setCtrl(view, 'x', 0.5);
          setCtrl(view, 'y', 0.5);
          this.refresh(view);
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    hit.on('pointerover', (ev) =>
      view.tooltip.show(['XY pad: drag the puck. X and Y are separate control outputs.'], ev.clientX, ev.clientY),
    );
    hit.on('pointerout', () => view.tooltip.hide());
    view.addChild(hit);

    view.buildSelector(view.paramCtrl(view.paramSpec('spring')), view.w / 2, view.h - 32, 12);
  }

  refresh(view: ModuleView): void {
    if (!this.g) return;
    const r = this.pad(view);
    const vx = Math.min(1, Math.max(0, view.instance.params.x ?? 0.5));
    const vy = Math.min(1, Math.max(0, view.instance.params.y ?? 0.5));
    const px = r.x + vx * r.w;
    const py = r.y + (1 - vy) * r.h;
    const g = this.g;
    g.clear();
    g.roundRect(r.x, r.y, r.w, r.h, 6).fill(theme.inset).stroke({ width: 1, color: theme.moduleStroke });
    g.moveTo(r.x + r.w / 2, r.y).lineTo(r.x + r.w / 2, r.y + r.h).stroke({ width: 1, color: theme.moduleStroke });
    g.moveTo(r.x, r.y + r.h / 2).lineTo(r.x + r.w, r.y + r.h / 2).stroke({ width: 1, color: theme.moduleStroke });
    g.moveTo(px, r.y).lineTo(px, r.y + r.h).stroke({ width: 1, color: theme.textDim, alpha: 0.4 });
    g.moveTo(r.x, py).lineTo(r.x + r.w, py).stroke({ width: 1, color: theme.textDim, alpha: 0.4 });
    g.circle(px, py, 9).fill(view.accent()).stroke({ width: 2, color: theme.text });
  }
}

export class ButtonFace implements FaceRenderer {
  private g: Graphics | null = null;

  private rect(view: ModuleView): { x: number; y: number; w: number; h: number } {
    return { x: 22, y: T + 10, w: view.w - 44, h: view.h - T - 72 };
  }

  build(view: ModuleView): void {
    this.g = new Graphics();
    view.addChild(this.g);
    this.refresh(view);

    const r = this.rect(view);
    view.setParamAnchor('value', r.x + r.w / 2, r.y + r.h / 2);
    const hit = new Graphics().rect(r.x, r.y, r.w, r.h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    const release = () => {
      if (Math.round(view.instance.params.mode ?? 0) === 0 && (view.instance.params.value ?? 0) > 0.5) {
        setCtrl(view, 'value', 0);
        this.refresh(view);
      }
    };
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      if (Math.round(view.instance.params.mode ?? 0) === 0) {
        // Momentary presses are transient — not worth an undo step.
        setCtrl(view, 'value', 1);
      } else {
        appState.beginUndoable();
        setCtrl(view, 'value', (view.instance.params.value ?? 0) > 0.5 ? 0 : 1);
      }
      this.refresh(view);
    });
    hit.on('pointerup', release);
    hit.on('pointerupoutside', release);
    hit.on('pointerover', (ev) =>
      view.tooltip.show(['Button: hold (momentary) or click (toggle). Output is 0 or 1.'], ev.clientX, ev.clientY),
    );
    hit.on('pointerout', () => view.tooltip.hide());
    view.addChild(hit);

    view.buildSelector(view.paramCtrl(view.paramSpec('mode')), view.w / 2, view.h - 34, 12);
  }

  refresh(view: ModuleView): void {
    if (!this.g) return;
    const r = this.rect(view);
    const on = (view.instance.params.value ?? 0) > 0.5;
    const g = this.g;
    g.clear();
    g.roundRect(r.x, r.y, r.w, r.h, 10)
      .fill(on ? view.accent() : theme.button)
      .stroke({ width: 2, color: on ? theme.text : theme.moduleStroke });
  }
}
