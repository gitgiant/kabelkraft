import { Graphics, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import type { ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/** Granular: live grain-cloud scatter plot + a click-to-load sample row. */
export class GranularFace implements FaceRenderer {
  private g: Graphics | null = null;
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private sampleText: Text | null = null;

  build(view: ModuleView): void {
    view.buildParamFace({
      display: (c) => {
        this.buildCloud(view, c.x, c.top + c.band + 4, c.gw, c.bottom - (c.top + c.band + 4) - 22);
        this.buildSampleRow(view, c.x, c.bottom - 16, c.gw);
      },
    });
  }

  live(view: ModuleView): void {
    if (!this.g) return;
    this.draw(view, appState.grainData[view.instance.id] ?? null);
    this.updateSampleName(view);
  }

  private buildCloud(view: ModuleView, x: number, y: number, w: number, h: number): void {
    this.rect = { x, y, w: Math.max(40, w), h: Math.max(24, h) };
    this.g = new Graphics();
    view.addChild(this.g);
    this.draw(view, null);
  }

  private draw(view: ModuleView, data: { g: Float32Array; c: number } | null): void {
    const g = this.g;
    if (!g) return;
    const { x, y, w, h } = this.rect;
    g.clear();
    g.roundRect(x, y, w, h, 4).fill({ color: 0x0d0d14 }).stroke({ width: 1, color: 0x2a2a36 });
    if (!data || data.c === 0) return;
    const c = data.c;
    for (let i = 0; i < c; i++) {
      const gx = x + 4 + Math.min(1, Math.max(0, data.g[i * 3])) * (w - 8);
      // y by playback rate (pitch): map ~0.25..4× across the height (log2)
      const rate = data.g[i * 3 + 1] || 1;
      const ny = Math.min(1, Math.max(0, (Math.log2(rate) + 2) / 4));
      const gy = y + h - 4 - ny * (h - 8);
      const phase = data.g[i * 3 + 2];
      const a = Math.sin(Math.PI * Math.min(1, Math.max(0, phase))); // fade in/out
      g.circle(gx, gy, 2).fill({ color: view.accent(), alpha: 0.25 + 0.6 * a });
    }
  }

  private buildSampleRow(view: ModuleView, x: number, y: number, _w: number): void {
    this.sampleText = new Text({ text: '', style: { fontSize: 10, fill: theme.textDim } });
    this.sampleText.position.set(x, y);
    this.sampleText.eventMode = 'static';
    this.sampleText.cursor = 'pointer';
    this.sampleText.on('pointerdown', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void appState.loadSampleFile(view.instance.id, file);
      };
      input.click();
    });
    this.sampleText.on('pointerover', (e) =>
      view.tooltip.show(['Sample', 'Click to load an audio file to granulate (Source = sample).'], e.clientX, e.clientY),
    );
    this.sampleText.on('pointerout', () => view.tooltip.hide());
    view.addChild(this.sampleText);
    this.updateSampleName(view);
  }

  private updateSampleName(view: ModuleView): void {
    if (!this.sampleText) return;
    const s = appState.samples.get(view.instance.id);
    this.sampleText.text = s ? `♪ ${s.name}` : '＋ load sample…';
  }
}
