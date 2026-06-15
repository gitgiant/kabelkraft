import { Graphics } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { clipFromData } from '../../core/composer';
import { MODULE_TITLE_H, type ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/** Composer (PRD §8.3): a piano-roll clip preview — beat grid + notes with a
 * transport playhead. Click opens the full editor. */
export class ComposerFace implements FaceRenderer {
  private g: Graphics | null = null;
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private lastPos = -1;
  private lastData: unknown = null;

  build(view: ModuleView): void {
    this.buildPreview(view, 10, MODULE_TITLE_H + 6, view.w - 20);
  }

  live(view: ModuleView): void {
    if (!this.g) return;
    let pos = -1;
    if (appState.transport.playing) {
      const len = Math.max(1, Number(view.instance.data?.length) || 16);
      // Quantize the playhead to ~half-pixel steps so we redraw sparingly.
      const step = len / (this.rect.w * 2);
      pos = Math.floor(((appState.transport.songPosition % len) + len) % len / step) * step;
    }
    if (pos !== this.lastPos || view.instance.data !== this.lastData) {
      this.lastPos = pos;
      this.lastData = view.instance.data;
      this.draw(view, pos);
    }
  }

  private buildPreview(view: ModuleView, x: number, y: number, w: number): void {
    const h = view.h - y - 12;
    this.rect = { x, y, w, h };
    const bg = new Graphics().roundRect(x, y, w, h, 4).fill(theme.graphBg);
    bg.eventMode = 'static';
    bg.cursor = 'pointer';
    bg.on('pointertap', (e) => {
      e.stopPropagation();
      appState.openComposer(view.instance.id);
    });
    bg.on('pointerover', (e) =>
      view.tooltip.show(
        ['Composer clip', 'Click to open the piano-roll editor: notes, tools, MIDI import/export.'],
        e.clientX,
        e.clientY,
      ),
    );
    bg.on('pointerout', () => view.tooltip.hide());
    view.addChild(bg);
    this.g = new Graphics();
    this.g.eventMode = 'none';
    view.addChild(this.g);

    this.draw(view, -1);
  }

  private draw(view: ModuleView, pos: number): void {
    if (!this.g) return;
    const { x, y, w, h } = this.rect;
    const clip = clipFromData(view.instance.data);
    const g = this.g;
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
}
