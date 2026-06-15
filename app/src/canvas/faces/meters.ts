import { Graphics, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import type { ModuleView } from '../ModuleView';

/** A live meter a face holds and drives from its own `live()`. */
export interface Meter {
  update(view: ModuleView): void;
}

/**
 * Vertical peak meter with a latching clip indicator (click to clear). Reads
 * `appState.meters[moduleId]`. Used by levels, recorder, and the audio rail
 * param faces.
 */
export class VMeter implements Meter {
  private bar: Graphics;
  private clipDot: Graphics;
  private rect: { x: number; y: number; w: number; h: number };
  private clipped = false;

  constructor(view: ModuleView, x: number, y: number, w: number, h: number) {
    const bg = new Graphics().roundRect(x, y, w, h, 3).fill(theme.inset);
    view.addChild(bg);
    this.bar = new Graphics();
    view.addChild(this.bar);
    this.clipDot = new Graphics();
    this.clipDot.circle(x + w / 2, y - 8, 4).fill(0x550000);
    this.clipDot.eventMode = 'static';
    this.clipDot.cursor = 'pointer';
    this.clipDot.on('pointerdown', (e) => {
      e.stopPropagation();
      this.clipped = false;
    });
    view.addChild(this.clipDot);
    this.rect = { x, y, w, h };
  }

  update(view: ModuleView): void {
    const reading = appState.meters[view.instance.id];
    const peak = reading?.peak ?? 0;
    if (reading?.clipped) this.clipped = true;
    this.bar.clear();
    const { x, y, w, h } = this.rect;
    const bh = Math.min(1, peak) * h;
    if (bh > 0.5) {
      // Vertical bar grows bottom→top, green/amber/red by level.
      this.bar
        .roundRect(x, y + h - bh, w, bh, 3)
        .fill(peak > 1 ? 0xff3030 : peak > 0.85 ? 0xffb13d : 0x52e07a);
    }
    this.clipDot.clear().circle(x + w / 2, y - 8, 4).fill(this.clipped ? 0xff2020 : 0x550000);
  }
}

/**
 * Gain-reduction meter: a downward red bar scaled to 24 dB full height. Reads
 * `appState.gainReduction[moduleId]`. Used by compressor/limiter/mbcomp.
 */
export class GrMeter implements Meter {
  private bar: Graphics;
  private rect: { x: number; y: number; w: number; h: number };

  constructor(view: ModuleView, x: number, y: number, w: number, h: number) {
    const label = new Text({ text: 'GR', style: { fontSize: 9, fill: theme.textDim } });
    label.anchor.set(0.5, 1);
    label.position.set(x + w / 2, y - 2);
    view.addChild(label);
    const bg = new Graphics().roundRect(x, y, w, h, 3).fill(theme.inset);
    view.addChild(bg);
    this.bar = new Graphics();
    view.addChild(this.bar);
    this.rect = { x, y, w, h };
  }

  update(view: ModuleView): void {
    const gr = appState.gainReduction[view.instance.id] ?? 0;
    const bh = Math.min(1, gr / 24) * this.rect.h;
    this.bar.clear();
    if (bh > 0.5) {
      this.bar.roundRect(this.rect.x, this.rect.y, this.rect.w, bh, 3).fill(0xff5050);
    }
  }
}
