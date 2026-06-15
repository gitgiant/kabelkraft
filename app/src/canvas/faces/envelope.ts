import { FederatedPointerEvent, Graphics } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { PORT_TYPE_COLORS } from '../../core/types';
import { MODULE_TITLE_H, type ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/** Display width (seconds) of the sustain plateau in the envelope contour. */
const SUSTAIN_DISPLAY_S = 0.4;

/** Curve params edited by dragging the contour — kept out of the knob grid. */
const ENV_CURVE_IDS = new Set(['atkCurve', 'decCurve', 'relCurve']);

/**
 * Per-stage envelope curve: linear phase t∈[0,1] → shaped 0..1. Mirrors
 * envShape() in engine-worklet.js. c=0 linear; c>0 convex; c<0 concave.
 */
function envShape(t: number, c: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (c > -1e-4 && c < 1e-4) return t;
  const k = 5 * c;
  return (Math.exp(k * t) - 1) / (Math.exp(k) - 1);
}

/** Envelope face: knob grid + draggable DAHDSR contour with a live playhead. */
export class EnvelopeFace implements FaceRenderer {
  private curveG: Graphics | null = null;
  private dotG: Graphics | null = null;
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private lastDot = NaN;
  private lastTap = 0;

  build(view: ModuleView): void {
    const x = 10;
    const y = MODULE_TITLE_H + 6;
    const w = view.w - 20;
    // Per-stage curves are edited by dragging the contour, not knobs.
    const ctrls = view
      .visibleParams()
      .filter((p) => !ENV_CURVE_IDS.has(p.id))
      .map((p) => view.paramCtrl(p));
    // Knob grid on top; the contour fills the rest of the tile below it.
    const band = view.ctrlBandH(ctrls, w);
    view.buildCtrlGrid(ctrls, x, y, w);

    const cy = y + band + 8;
    this.rect = { x, y: cy, w, h: view.h - cy - 12 };
    this.curveG = new Graphics();
    this.curveG.eventMode = 'static';
    this.curveG.cursor = 'ns-resize';
    this.curveG.on('pointerdown', (e) => this.onCurveDown(view, e));
    view.addChild(this.curveG);
    this.dotG = new Graphics();
    this.dotG.eventMode = 'none';
    view.addChild(this.dotG);
    this.refresh(view);
  }

  live(view: ModuleView): void {
    if (!this.dotG) return;
    const out = appState.controlValues[view.instance.id] ?? 0;
    if (out !== this.lastDot) {
      this.lastDot = out;
      this.drawDot(view, out);
    }
  }

  /**
   * Hit-test a local x against the contour's stage layout. Returns the curve
   * param for the slope under x (attack/decay/release), or null over the flat
   * delay/hold/sustain segments. Mirrors the stage durations in refresh().
   */
  private curveHit(view: ModuleView, localX: number): { id: string; def: number } | null {
    const r = this.rect;
    const p = view.instance.params;
    const segs: Array<{ t: number; id?: string; def?: number }> = [
      { t: p.delay ?? 0 },
      { t: p.attack ?? 0.05, id: 'atkCurve', def: 0 },
      { t: p.hold ?? 0 },
      { t: p.decay ?? 0.2, id: 'decCurve', def: -0.4 },
      { t: SUSTAIN_DISPLAY_S },
      { t: p.release ?? 0.3, id: 'relCurve', def: -0.4 },
    ];
    const total = segs.reduce((s, st) => s + Math.max(st.t, 0), 0) || 1;
    let acc = 0;
    for (const st of segs) {
      const dur = Math.max(st.t, 0);
      const x0 = r.x + (acc / total) * r.w;
      const x1 = r.x + ((acc + dur) / total) * r.w;
      if (st.id && localX >= x0 && localX < x1) return { id: st.id, def: st.def! };
      acc += dur;
    }
    return null;
  }

  /** Pointerdown on the contour: double-tap resets the slope, else drags it. */
  private onCurveDown(view: ModuleView, e: FederatedPointerEvent): void {
    const hit = this.curveHit(view, e.getLocalPosition(view).x);
    if (!hit) return; // flat segment → fall through to body drag (move module)
    e.stopPropagation();
    const now = performance.now();
    if (now - this.lastTap < 350) {
      this.lastTap = 0;
      appState.beginUndoable();
      appState.setParam(view.instance.id, hit.id, hit.def);
      return;
    }
    this.lastTap = now;
    this.beginDrag(view, e, hit);
  }

  /** Vertical drag on a slope: up increases the stage curve (-1..1). */
  private beginDrag(view: ModuleView, e: FederatedPointerEvent, hit: { id: string; def: number }): void {
    appState.beginUndoable();
    const startY = e.clientY;
    const startCurve = view.instance.params[hit.id] ?? hit.def;
    const label = hit.id === 'atkCurve' ? 'Atk Crv' : hit.id === 'decCurve' ? 'Dec Crv' : 'Rel Crv';
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > 2) moved = true;
      if (!moved) return;
      const c = Math.min(1, Math.max(-1, startCurve - (dy / this.rect.h) * 2));
      appState.setParam(view.instance.id, hit.id, c);
      view.tooltip.showNow([`${label} ${c.toFixed(2)}`], ev.clientX, ev.clientY);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      view.tooltip.hide();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** Output value of the envelope at raw progress `env` (0..1), vel assumed 1. */
  private out(view: ModuleView, env: number): number {
    const p = view.instance.params;
    const v = (p.invert ? 1 - env : env) * (p.depth ?? 1);
    return p.bipolar ? v * 2 - (p.depth ?? 1) : v;
  }

  /** Map an output value to a y within the contour box (handles bipolar). */
  private yFor(view: ModuleView, out: number): number {
    const r = this.rect;
    const bip = (view.instance.params.bipolar ?? 0) > 0.5;
    const norm = bip ? (out + 1) / 2 : out; // -1..1 → 0..1, else already 0..1
    return r.y + r.h - Math.max(0, Math.min(1, norm)) * r.h;
  }

  /** Static DAHDSR contour, x ∝ stage time, y = output (depth/invert/bipolar). */
  refresh(view: ModuleView): void {
    if (!this.curveG) return;
    const g = this.curveG;
    const r = this.rect;
    const p = view.instance.params;

    g.clear();
    g.roundRect(r.x, r.y, r.w, r.h, 4).fill(theme.inset);
    if ((p.bipolar ?? 0) > 0.5) {
      const zy = this.yFor(view, 0);
      g.moveTo(r.x, zy).lineTo(r.x + r.w, zy).stroke({ width: 1, color: theme.moduleStroke, alpha: 0.6 });
    }

    // Stage durations laid along x; sustain gets a fixed display segment.
    const sustain = p.sustain ?? 0.6;
    const stages: Array<{ t: number; shape: (f: number) => number }> = [
      { t: p.delay ?? 0, shape: () => 0 },
      { t: p.attack ?? 0.05, shape: (f) => envShape(f, p.atkCurve ?? 0) },
      { t: p.hold ?? 0, shape: () => 1 },
      { t: p.decay ?? 0.2, shape: (f) => 1 + (sustain - 1) * envShape(f, p.decCurve ?? 0) },
      { t: SUSTAIN_DISPLAY_S, shape: () => sustain },
      { t: p.release ?? 0.3, shape: (f) => sustain * (1 - envShape(f, p.relCurve ?? 0)) },
    ];
    const total = stages.reduce((s, st) => s + Math.max(st.t, 0), 0) || 1;

    const pts: Array<{ x: number; y: number }> = [];
    let acc = 0;
    const SEG = 12;
    for (const st of stages) {
      const dur = Math.max(st.t, 0);
      const x0 = r.x + (acc / total) * r.w;
      const x1 = r.x + ((acc + dur) / total) * r.w;
      for (let i = 0; i <= SEG; i++) {
        const f = i / SEG;
        pts.push({ x: x0 + (x1 - x0) * f, y: this.yFor(view, this.out(view, st.shape(f))) });
      }
      acc += dur;
    }

    // Filled area under the contour, then the line.
    const base = this.yFor(view, (p.bipolar ?? 0) > 0.5 ? -1 : 0);
    g.moveTo(pts[0].x, base);
    for (const pt of pts) g.lineTo(pt.x, pt.y);
    g.lineTo(pts[pts.length - 1].x, base);
    g.closePath();
    g.fill({ color: PORT_TYPE_COLORS.control, alpha: 0.16 });
    g.moveTo(pts[0].x, pts[0].y);
    for (const pt of pts) g.lineTo(pt.x, pt.y);
    g.stroke({ width: 2, color: PORT_TYPE_COLORS.control });
  }

  /** Live playhead dot riding the contour at the current output level. */
  private drawDot(view: ModuleView, out: number): void {
    if (!this.dotG) return;
    const r = this.rect;
    const g = this.dotG;
    g.clear();
    g.circle(r.x + r.w - 6, this.yFor(view, out), 4)
      .fill(PORT_TYPE_COLORS.control)
      .stroke({ width: 1.5, color: theme.text });
  }
}
