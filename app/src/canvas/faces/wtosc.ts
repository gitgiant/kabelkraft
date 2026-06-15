import { Graphics, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { sampleKey } from '../../core/samples';
import { buildWavetable, defaultWavetable, framePoints, type WtTable } from '../../core/wavetable';
import type { ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/**
 * Wavetable oscillator: a 2.5D frame-stack + resolved-cycle display over an
 * A/B wavetable-slot loader row. pos/morph track per-frame from worklet state.
 */
export class WtoscFace implements FaceRenderer {
  private rowTextA: Text | null = null;
  private rowTextB: Text | null = null;
  private display: Graphics | null = null;
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private tableA: WtTable | null = null;
  private tableB: WtTable | null = null;
  private lastDraw = { pos: -1, morph: -1 };

  build(view: ModuleView): void {
    view.buildParamFace({
      display: (c) => {
        // Reserve the bottom A/B loader row (mirrors the old bottomRow:'wavetable').
        const bottom = c.bottom - 42;
        this.buildDisplay(view, c.x, c.top + c.band + 4, c.gw, bottom - (c.top + c.band + 4));
        this.buildRow(view, c.x, view.h - 40, c.gw);
      },
    });
  }

  /** A wavetable file loaded into a slot — rebuild tables + slot labels. */
  refreshSample(view: ModuleView): void {
    this.updateRowText(view);
    if (this.display) this.rebuildTables(view);
  }

  live(view: ModuleView): void {
    if (!this.display) return;
    const d = appState.wtData[view.instance.id];
    const params = view.instance.params;
    const pos = d ? d.pos : Math.min(1, Math.max(0, Number(params.wtPos) || 0));
    const morph = d ? d.morph : Math.min(1, Math.max(0, Number(params.morph) || 0));
    if (Math.abs(pos - this.lastDraw.pos) > 0.002 || Math.abs(morph - this.lastDraw.morph) > 0.002) {
      this.lastDraw = { pos, morph };
      this.draw(pos, morph);
    }
  }

  private buildRow(view: ModuleView, x: number, y: number, w: number): void {
    this.rowTextA = this.buildSlotRow(view, x, y, w, 0);
    this.rowTextB = this.buildSlotRow(view, x, y + 18, w, 1);
    this.updateRowText(view);
  }

  /** One A/B wavetable-slot row: label text + click-to-load hit rect. */
  private buildSlotRow(view: ModuleView, x: number, y: number, w: number, slot: number): Text {
    const text = new Text({ text: '', style: { fontSize: 10, fill: theme.textDim } });
    text.position.set(x, y);
    view.addChild(text);

    const hit = new Graphics().rect(x - 4, y - 3, w + 8, 17).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void appState.loadSampleFile(view.instance.id, file, slot);
      };
      input.click();
    });
    hit.on('pointerover', (e) =>
      view.tooltip.show(
        [
          `Wavetable ${slot === 1 ? 'B' : 'A'}`,
          'Click to load a wavetable file (2048-sample frames; short files become one cycle). Morph crossfades A↔B.',
        ],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => view.tooltip.hide());
    view.addChild(hit);
    return text;
  }

  private updateRowText(view: ModuleView): void {
    const data = view.instance.data ?? {};
    if (this.rowTextA) {
      const a = (data.sampleNameA as string) || '';
      this.rowTextA.text = a ? `A: ${a}` : 'A: built-in — click to load';
    }
    if (this.rowTextB) {
      const b = (data.sampleNameB as string) || '';
      this.rowTextB.text = b ? `B: ${b}` : 'B: (empty) — click to load';
    }
  }

  private buildDisplay(view: ModuleView, x: number, y: number, w: number, h: number): void {
    this.rect = { x, y, w, h: Math.max(40, h) };
    this.display = new Graphics();
    view.addChild(this.display);
    this.rebuildTables(view);
    this.lastDraw = { pos: -1, morph: -1 };
    this.draw(0, 0);
  }

  /** (Re)build the A/B frame tables from loaded PCM, or the built-in default for A. */
  private rebuildTables(view: ModuleView): void {
    const a = appState.samples.get(sampleKey(view.instance.id, 0));
    const b = appState.samples.get(sampleKey(view.instance.id, 1));
    this.tableA = (a && buildWavetable(a.channels[0])) || defaultWavetable();
    this.tableB = (b && buildWavetable(b.channels[0])) || null;
    this.lastDraw = { pos: -1, morph: -1 }; // force redraw with fresh tables
  }

  private draw(pos: number, morph: number): void {
    const g = this.display;
    if (!g || !this.tableA) return;
    const { x, y, w, h } = this.rect;
    g.clear();
    g.roundRect(x, y, w, h, 4).fill({ color: 0x0d0d14 }).stroke({ width: 1, color: 0x2a2a36 });

    const stackH = h * 0.6;
    const cycleH = h - stackH;
    const N = 72;

    // -- 2.5D frame stack (back-to-front), highlight the frame at `pos` ------
    const wtA = this.tableA;
    const shown = Math.min(wtA.frames, 16);
    const depthX = w * 0.22;
    const plotW = w - depthX - 10;
    const rowTop = y + 8;
    const rowH = stackH - 16;
    const curFrame = pos * (wtA.frames - 1);
    for (let s = 0; s < shown; s++) {
      const f = shown === 1 ? 0 : (s / (shown - 1)) * (wtA.frames - 1);
      const depth = shown === 1 ? 1 : s / (shown - 1); // 0 = back, 1 = front
      const ox = x + 6 + (1 - depth) * depthX;
      const oy = rowTop + depth * (rowH - 14) + 10;
      const amp = 5 + depth * 7;
      const near = Math.abs(f - curFrame) < (wtA.frames - 1) / shown / 2 + 0.5;
      const pts = framePoints(wtA, wtA.frames > 1 ? f / (wtA.frames - 1) : 0, N);
      for (let k = 0; k < N; k++) {
        const px = ox + (k / (N - 1)) * plotW;
        const py = oy - pts[k] * amp;
        if (k === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke({ width: near ? 1.6 : 1, color: near ? 0xffb13d : 0x4a4a64, alpha: near ? 1 : 0.5 + depth * 0.3 });
    }

    // -- resolved output cycle (A@pos crossfaded with B@pos by morph) --------
    const cy = y + stackH + cycleH / 2;
    const cAmp = cycleH / 2 - 6;
    const aPts = framePoints(wtA, pos, N);
    const bPts = morph > 0 && this.tableB ? framePoints(this.tableB, pos, N) : null;
    for (let k = 0; k < N; k++) {
      const v = bPts ? aPts[k] * (1 - morph) + bPts[k] * morph : aPts[k];
      const px = x + 6 + (k / (N - 1)) * (w - 12);
      const py = cy - v * cAmp;
      if (k === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke({ width: 1.8, color: 0xffb13d });
  }
}
