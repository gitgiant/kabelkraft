import { FederatedPointerEvent, Graphics } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { bandCoefs, chainResponseDb } from '../../core/eqmath';
import { MODULE_TITLE_H, type ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

const PEQ_COLORS = [0xff5050, 0xffb13d, 0x52e07a, 0x3dd9ff, 0xb070ff, 0xff3dd0];

/** Parametric EQ face: a log-frequency response plot with six draggable band
 * dots over a live input spectrum. */
export class PeqFace implements FaceRenderer {
  private plot: Graphics | null = null;
  private spectrumG: Graphics | null = null;
  private dots: Graphics[] = [];
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private lastSpectrum: number[] | null = null;

  private freqToX(f: number): number {
    const { x, w } = this.rect;
    return x + (Math.log10(Math.max(20, f) / 20) / 3) * w;
  }

  private gainToY(db: number): number {
    const { y, h } = this.rect;
    return y + h / 2 - (db / 18) * (h / 2);
  }

  build(view: ModuleView): void {
    const x = 10;
    const y = MODULE_TITLE_H + 6;
    const w = view.w - 20;
    const h = view.h - y - 14;
    this.rect = { x, y, w, h };

    const bg = new Graphics().roundRect(x, y, w, h, 4).fill(theme.inset);
    view.addChild(bg);
    this.spectrumG = new Graphics();
    view.addChild(this.spectrumG);
    this.plot = new Graphics();
    this.plot.eventMode = 'none';
    view.addChild(this.plot);

    this.dots = [];
    for (let n = 1; n <= 6; n++) {
      const dot = new Graphics();
      dot.circle(0, 0, 6).fill(PEQ_COLORS[n - 1]).stroke({ width: 1.5, color: 0x16161c });
      dot.eventMode = 'static';
      dot.cursor = 'move';
      dot.hitArea = { contains: (px: number, py: number) => px * px + py * py < 14 * 14 };
      dot.on('pointerdown', (e) => {
        e.stopPropagation();
        this.beginBandDrag(view, n, e);
      });
      dot.on('pointerover', (e) => {
        const p = view.instance.params;
        view.tooltip.show(
          [`Band ${n}: ${this.bandLabel(view, n)}`,
            `${Math.round(p[`b${n}freq`])} Hz, ${p[`b${n}gain`].toFixed(1)} dB, Q ${p[`b${n}q`].toFixed(2)}. Drag: freq/gain. Shift-drag: Q. Click: type.`],
          e.clientX,
          e.clientY,
        );
      });
      dot.on('pointerout', () => view.tooltip.hide());
      view.addChild(dot);
      this.dots.push(dot);
    }
    this.refresh(view);
  }

  live(view: ModuleView): void {
    if (!this.spectrumG) return;
    const spectrum = appState.spectra[view.instance.id];
    if (spectrum && spectrum !== this.lastSpectrum) {
      this.lastSpectrum = spectrum;
      this.drawSpectrum(spectrum);
    }
  }

  private bandLabel(view: ModuleView, n: number): string {
    const types = ['peak', 'lo-shelf', 'hi-shelf', 'lo-cut', 'hi-cut'];
    return types[Math.round(view.instance.params[`b${n}type`] ?? 0)] ?? 'peak';
  }

  private beginBandDrag(view: ModuleView, n: number, e: FederatedPointerEvent): void {
    appState.beginUndoable();
    const startX = e.clientX;
    const startY = e.clientY;
    const p = view.instance.params;
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
        appState.setParam(view.instance.id, `b${n}q`, q);
        view.tooltip.showNow([`Q ${q.toFixed(2)}`], ev.clientX, ev.clientY);
      } else {
        const freq = Math.min(20000, Math.max(20, startFreq * Math.pow(10, (dx / this.rect.w) * 3)));
        const gain = Math.min(18, Math.max(-18, startGain - (dy / (this.rect.h / 2)) * 18));
        appState.setParam(view.instance.id, `b${n}freq`, freq);
        appState.setParam(view.instance.id, `b${n}gain`, gain);
        view.tooltip.showNow([`${Math.round(freq)} Hz  ${gain.toFixed(1)} dB`], ev.clientX, ev.clientY);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      view.tooltip.hide();
      if (!moved) {
        const next = (Math.round(view.instance.params[`b${n}type`] ?? 0) + 1) % 5;
        appState.setParam(view.instance.id, `b${n}type`, next);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** Grid + combined response curve + dot positions. Called on param changes. */
  refresh(view: ModuleView): void {
    if (!this.plot) return;
    const { x, y, w, h } = this.rect;
    const g = this.plot;
    const sr = appState.engine.sampleRate;
    g.clear();

    for (const f of [100, 1000, 10000]) {
      const gx = this.freqToX(f);
      g.moveTo(gx, y).lineTo(gx, y + h);
    }
    g.moveTo(x, y + h / 2).lineTo(x + w, y + h / 2);
    g.stroke({ width: 1, color: 0xffffff, alpha: 0.08 });

    const p = view.instance.params;
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
      const gy = this.gainToY(db);
      if (first) {
        g.moveTo(x + px, gy);
        first = false;
      } else {
        g.lineTo(x + px, gy);
      }
    }
    g.stroke({ width: 2, color: 0xffb13d, alpha: 0.95 });

    this.dots.forEach((dot, i) => {
      const n = i + 1;
      dot.position.set(
        this.freqToX(p[`b${n}freq`] ?? 1000),
        this.gainToY(Math.min(18, Math.max(-18, p[`b${n}gain`] ?? 0))),
      );
    });
  }

  private drawSpectrum(spectrum: number[]): void {
    if (!this.spectrumG) return;
    const { x, y, w, h } = this.rect;
    const g = this.spectrumG;
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
}
