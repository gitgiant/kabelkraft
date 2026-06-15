import { Graphics } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { MODULE_TITLE_H, type ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

interface Strip {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bar: Graphics;
  dot: Graphics;
  clipped: boolean;
}

/** Mixer: 5 console strips (4 channels + master bus) — EQ/filter/send knobs,
 * pan, fader + pre-fader strip meter, plus send-pole visibility. */
export class MixerFace implements FaceRenderer {
  private meters: Strip[] = [];

  build(view: ModuleView): void {
    this.buildStrips(view, 10, MODULE_TITLE_H + 18, view.w - 20);
  }

  live(view: ModuleView): void {
    if (this.meters.length === 0) return;
    this.updateSendPoles(view);
    for (const m of this.meters) {
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

  private buildStrips(view: ModuleView, x: number, y: number, w: number): void {
    const chW = w / 5;
    const r = Math.max(9, Math.min(13, chW * 0.22));
    const pitch = r * 2 + 24;
    const knobIds = ['eqHi', 'eqMid', 'eqLo', 'filt', 'send'];
    for (let ch = 1; ch <= 5; ch++) {
      const cx = x + (ch - 1) * chW + chW / 2;
      knobIds.forEach((pid, k) => {
        view.buildKnob(view.paramCtrl(view.paramSpec(`${pid}${ch}`)), cx, y + r + 12 + k * pitch, r);
      });
      const panCy = view.h - r - 24;
      view.buildKnob(view.paramCtrl(view.paramSpec(`pan${ch}`)), cx, panCy, r);

      // Fader with its strip meter beside it (channels pre-fader, master = out).
      const fy = y + 24 + knobIds.length * pitch;
      const fh = Math.max(40, panCy - r - 30 - fy);
      const fw = Math.max(10, Math.min(14, chW * 0.22));
      const mw = 5;
      const fx = cx - (fw + 3 + mw) / 2;
      view.buildFader(view.paramCtrl(view.paramSpec(`lvl${ch}`)), fx, fy, fw, fh);
      const mx = fx + fw + 3;
      view.addChild(new Graphics().roundRect(mx, fy, mw, fh, 2).fill(theme.inset));
      const bar = new Graphics();
      bar.eventMode = 'none';
      view.addChild(bar);
      const dot = new Graphics();
      dot.eventMode = 'static';
      dot.cursor = 'pointer';
      view.addChild(dot);
      const m: Strip = {
        key: ch === 5 ? view.instance.id : `${view.instance.id}:ch${ch}`,
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
      this.meters.push(m);
    }
  }

  /** Send poles show only while their knob is up or a wire is attached. */
  private updateSendPoles(view: ModuleView): void {
    let wired: Set<string> | null = null;
    for (let ch = 1; ch <= 5; ch++) {
      const pid = `send${ch}`;
      const dot = view.portDot(pid);
      if (!dot) continue;
      if ((view.instance.params[pid] ?? 0) > 0.001) {
        dot.visible = true;
        continue;
      }
      if (!wired) {
        wired = new Set();
        for (const wire of appState.graph.wires.values()) {
          if (wire.from.moduleId === view.instance.id) wired.add(wire.from.portId);
        }
      }
      dot.visible = wired.has(pid);
    }
  }
}
