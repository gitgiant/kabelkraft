import { Graphics, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { PORT_TYPE_COLORS } from '../../core/types';
import { MODULE_TITLE_H, type ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/**
 * TODO(intelligence): placeholder face only. One mock "AI prompt window"
 * row appears per wired input type; nothing generates yet. Planned: each
 * row opens an input-aware prompt panel (audio → analysis, notes → MIDI
 * generation, text → lyrics/visual prompts, visual → scene edits) through
 * the shared buildAiContext() pipeline, plus matching output ports.
 */
export class IntelligenceFace implements FaceRenderer {
  build(view: ModuleView): void {
    this.buildBody(view, 10, MODULE_TITLE_H + 6, view.w - 20);
  }

  private buildBody(view: ModuleView, x: number, y: number, w: number): void {
    const wired = view.def.ports.filter(
      (p) =>
        p.direction === 'in' &&
        [...appState.graph.wires.values()].some(
          (wr) => wr.to.moduleId === view.instance.id && wr.to.portId === p.id,
        ),
    );

    if (wired.length === 0) {
      const hint = new Text({
        text: '🤖 Wire any signal in —\na matching AI prompt\nwindow appears here.',
        style: { fontSize: 11, fill: theme.textDim, lineHeight: 17 },
      });
      hint.position.set(x, y + 6);
      view.addChild(hint);
      return;
    }

    let py = y + 2;
    const rowH = 40;
    for (const p of wired) {
      if (py + rowH > view.h - 12) break; // stretch the tile for more rows
      const g = new Graphics();
      g.roundRect(x, py, w, rowH - 6, 6)
        .fill({ color: 0x000000, alpha: 0.2 })
        .stroke({ width: 1, color: theme.moduleStroke });
      g.circle(x + 12, py + (rowH - 6) / 2, 4).fill(PORT_TYPE_COLORS[p.type]);
      view.addChild(g);
      const label = new Text({
        text: `${p.label} prompt`,
        style: { fontSize: 11, fontWeight: '700', fill: theme.text },
      });
      label.position.set(x + 24, py + 5);
      view.addChild(label);
      const stub = new Text({
        text: '✨ Describe what to generate… (coming soon)',
        style: { fontSize: 9, fill: theme.textDim },
      });
      stub.position.set(x + 24, py + 19);
      view.addChild(stub);
      py += rowH;
    }
  }
}
