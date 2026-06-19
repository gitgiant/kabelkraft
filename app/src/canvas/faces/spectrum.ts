import { Graphics } from 'pixi.js';
import { appState } from '../../state';
import type { ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/** Additive osc: partial-gain spectrum bars, computed UI-side from params. */
export class SpectrumFace implements FaceRenderer {
  private g: Graphics | null = null;
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Status version last drawn — gates the live (tilt-mod) redraw to ~30Hz. */
  private lastModV = -1;
  private wasModulated = false;

  build(view: ModuleView): void {
    view.buildParamFace({
      display: (c) => this.buildDisplay(view, c.x, c.top + c.band + 4, c.gw, c.bottom - (c.top + c.band + 4)),
    });
  }

  private buildDisplay(view: ModuleView, x: number, y: number, w: number, h: number): void {
    this.rect = { x, y, w: Math.max(40, w), h: Math.max(30, h) };
    this.g = new Graphics();
    view.addChild(this.g);
    this.refresh(view);
  }

  /** Redraw bars at the live modulated tilt when a mod wire drives it. */
  live(view: ModuleView): void {
    const isMod = appState.modVals[view.instance.id]?.tilt !== undefined;
    if ((isMod || this.wasModulated) && appState.modVersion !== this.lastModV) {
      this.lastModV = appState.modVersion;
      this.wasModulated = isMod;
      this.refresh(view);
    }
  }

  refresh(view: ModuleView): void {
    const g = this.g;
    if (!g) return;
    const { x, y, w, h } = this.rect;
    g.clear();
    g.roundRect(x, y, w, h, 4).fill({ color: 0x0d0d14 }).stroke({ width: 1, color: 0x2a2a36 });
    const p = view.instance.params;
    const P = Math.max(1, Math.min(64, Math.round(Number(p.partials) || 16)));
    const tiltEff = appState.modVals[view.instance.id]?.tilt?.[0] ?? (Number(p.tilt) || 0);
    const tExp = tiltEff / 6.0206;
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
      g.rect(bx, base - bh, Math.max(1, bw - 1), bh).fill({ color: view.accent(), alpha: 0.85 });
    }
  }
}
