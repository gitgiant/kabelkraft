import { Graphics } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { PORT_TYPE_COLORS } from '../../core/types';
import { biquadResponseDb, vcfCoefs } from '../../core/eqmath';
import { MODULE_TITLE_H, type ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/** Filter face: mode selector + cutoff/res/amt knobs over a log-frequency
 * response curve that is draggable (x = cutoff, y = Q). */
export class VcfFace implements FaceRenderer {
  private curveG: Graphics | null = null;
  private rect = { x: 0, y: 0, w: 0, h: 0 };

  build(view: ModuleView): void {
    const x = 10;
    const y = MODULE_TITLE_H + 6;
    const w = view.w - 20;
    const r = Math.max(12, Math.min(20, w / 11));
    const knobY = y + r + 16;
    view.buildSelector(view.paramCtrl(view.paramSpec('mode')), x + w * 0.125, knobY, r);
    view.buildKnob(view.paramCtrl(view.paramSpec('cutoff')), x + w * 0.375, knobY, r);
    view.buildKnob(view.paramCtrl(view.paramSpec('res')), x + w * 0.625, knobY, r);
    view.buildKnob(view.paramCtrl(view.paramSpec('amt')), x + w * 0.875, knobY, r);

    const cy = knobY + r + 26;
    this.rect = { x, y: cy, w, h: view.h - cy - 12 };
    this.curveG = new Graphics();
    view.addChild(this.curveG);
    this.refresh(view);

    const rect = this.rect;
    const hit = new Graphics().rect(rect.x, rect.y, rect.w, rect.h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'crosshair';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.beginUndoable();
      const cutoff = view.paramCtrl(view.paramSpec('cutoff'));
      const res = view.paramCtrl(view.paramSpec('res'));
      const apply = (lx: number, ly: number) => {
        cutoff.set(view.ctrlFromNorm(cutoff, (lx - rect.x) / rect.w));
        res.set(view.ctrlFromNorm(res, 1 - (ly - rect.y) / rect.h));
        view.refreshParams();
      };
      const first = view.toLocal(e.global);
      apply(first.x, first.y);
      const scale = view.worldTransform.a || 1;
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
      view.tooltip.show(
        ['Filter response', 'Drag: horizontal = cutoff, vertical = Q.'],
        ev.clientX,
        ev.clientY,
      ),
    );
    hit.on('pointerout', () => view.tooltip.hide());
    view.addChild(hit);
  }

  /** Visual indicator: log-frequency magnitude curve of the current settings. */
  refresh(view: ModuleView): void {
    if (!this.curveG) return;
    const g = this.curveG;
    const r = this.rect;
    const p = view.instance.params;
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
}
