import { Graphics } from 'pixi.js';
import { appState } from '../../state';
import type { ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/** Pluck / resonator: live string-displacement waveform under the knob band. */
export class StringFace implements FaceRenderer {
  private g: Graphics | null = null;
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private wasActive = false;

  build(view: ModuleView): void {
    view.buildParamFace({
      display: (c) => this.buildDisplay(view, c.x, c.top + c.band + 4, c.gw, c.bottom - (c.top + c.band + 4)),
    });
  }

  private buildDisplay(view: ModuleView, x: number, y: number, w: number, h: number): void {
    this.rect = { x, y, w: Math.max(40, w), h: Math.max(30, h) };
    this.g = new Graphics();
    view.addChild(this.g);
    this.draw(null);
  }

  live(view: ModuleView): void {
    if (!this.g) return;
    const d = appState.stringData[view.instance.id];
    if (d || this.wasActive) {
      this.draw(d ?? null);
      this.wasActive = !!(d && d.a > 0.5);
    }
  }

  private draw(data: { s: Float32Array; a: number } | null): void {
    const g = this.g;
    if (!g) return;
    const { x, y, w, h } = this.rect;
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
}
