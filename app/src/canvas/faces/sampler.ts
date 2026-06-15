import { Graphics, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import type { ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/** Sampler: a waveform thumbnail + a click-to-load / click-to-edit name row. */
export class SamplerFace implements FaceRenderer {
  private waveform: Graphics | null = null;
  private nameText: Text | null = null;
  private rect = { x: 0, y: 0, w: 0, h: 0 };

  build(view: ModuleView): void {
    view.buildParamFace({
      display: (c) => this.buildBody(view, c.x, c.top + c.band + 6, c.gw),
    });
  }

  refreshSample(view: ModuleView): void {
    if (!this.waveform) return;
    const { x, y, w, h } = this.rect;
    const g = this.waveform;
    g.clear();
    g.roundRect(x, y, w, h, 4).fill(theme.inset);
    const sample = appState.samples.get(view.instance.id);
    if (this.nameText) {
      this.nameText.text = sample ? sample.name : 'no sample — click waveform area to load';
    }
    if (!sample) return;
    const pcm = sample.channels[0];
    const mid = y + h / 2;
    const cols = Math.floor(w) - 8;
    const step = pcm.length / cols;
    for (let c = 0; c < cols; c++) {
      let min = 1;
      let max = -1;
      const start = Math.floor(c * step);
      const end = Math.min(pcm.length, Math.ceil((c + 1) * step));
      // Sparse scan keeps long samples cheap; thumbnails don't need exactness.
      const stride = Math.max(1, Math.floor((end - start) / 16));
      for (let i = start; i < end; i += stride) {
        const v = pcm[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max < min) continue;
      const x0 = x + 4 + c;
      g.moveTo(x0, mid + min * (h / 2 - 3));
      g.lineTo(x0, mid + max * (h / 2 - 3));
    }
    g.stroke({ width: 1, color: 0xffb13d, alpha: 0.9 });
  }

  private buildBody(view: ModuleView, x: number, y: number, w: number): void {
    const h = Math.max(40, view.h - y - 28);
    this.rect = { x, y, w, h };
    this.waveform = new Graphics();
    view.addChild(this.waveform);

    this.nameText = new Text({ text: '', style: { fontSize: 10, fill: theme.textDim } });
    this.nameText.position.set(x, y + h + 6);
    // Loaded sample's name opens the Sample Editor (PRD §8.2).
    this.nameText.eventMode = 'static';
    this.nameText.cursor = 'pointer';
    this.nameText.on('pointerdown', (e) => {
      if (!appState.samples.has(view.instance.id)) return; // falls through to file load
      e.stopPropagation();
      appState.openSampleEditor(view.instance.id);
    });
    this.nameText.on('pointerover', (e) => {
      if (appState.samples.has(view.instance.id)) {
        view.tooltip.show(['Sample Editor', 'Click to edit: trim, normalize, loop points…'], e.clientX, e.clientY);
      }
    });
    this.nameText.on('pointerout', () => view.tooltip.hide());
    view.addChild(this.nameText);

    const hit = new Graphics().rect(x, y, w, h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
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
    hit.on('pointerover', (e) =>
      view.tooltip.show(
        ['Sample', appState.samples.has(view.instance.id) ? 'Click to load a different file.' : 'Click to load an audio file.'],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => view.tooltip.hide());
    view.addChild(hit);
    this.refreshSample(view);
  }
}
