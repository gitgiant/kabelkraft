import { Graphics, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { MODMATRIX_SIZE } from '../../core/registry';
import { MODULE_TITLE_H, type ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/** 4×4 modulation depth grid: rows = control inputs, columns = control
 * outputs. Drag a cell up/down to set depth (±1); double-click zeroes it. */
export class ModmatrixFace implements FaceRenderer {
  private g: Graphics | null = null;
  private rect = { x: 0, y: 0, w: 0, h: 0 };

  build(view: ModuleView): void {
    this.buildGrid(view, 10, MODULE_TITLE_H + 6, view.w - 20);
  }

  refresh(view: ModuleView): void {
    this.draw(view);
  }

  private buildGrid(view: ModuleView, x: number, y: number, w: number): void {
    const labelW = 30;
    const labelH = 14;
    const gx = x + labelW;
    const gy = y + labelH;
    const gw = w - labelW;
    const gh = Math.max(60, view.h - gy - 14);
    this.rect = { x: gx, y: gy, w: gw, h: gh };

    const n = MODMATRIX_SIZE;
    for (let j = 0; j < n; j++) {
      const t = new Text({ text: `→${j + 1}`, style: { fontSize: 9, fill: theme.textDim } });
      t.anchor.set(0.5, 0);
      t.position.set(gx + (j + 0.5) * (gw / n), y);
      t.eventMode = 'none';
      view.addChild(t);
    }
    for (let i = 0; i < n; i++) {
      const t = new Text({ text: `${i + 1}`, style: { fontSize: 9, fill: theme.textDim } });
      t.anchor.set(1, 0.5);
      t.position.set(gx - 6, gy + (i + 0.5) * (gh / n));
      t.eventMode = 'none';
      view.addChild(t);
    }

    this.g = new Graphics();
    view.addChild(this.g);
    this.draw(view);

    const hit = new Graphics().rect(gx, gy, gw, gh).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'ns-resize';
    let lastTap = { cell: '', at: 0 };
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      const local = view.toLocal(e.global);
      const i = Math.min(n - 1, Math.max(0, Math.floor(((local.y - gy) / gh) * n)));
      const j = Math.min(n - 1, Math.max(0, Math.floor(((local.x - gx) / gw) * n)));
      const paramId = `m${i + 1}${j + 1}`;
      // Double-click zeroes the crossing.
      const now = performance.now();
      if (lastTap.cell === paramId && now - lastTap.at < 350) {
        appState.beginUndoable();
        appState.setParam(view.instance.id, paramId, 0);
        this.draw(view);
        return;
      }
      lastTap = { cell: paramId, at: now };

      appState.beginUndoable();
      const start = view.instance.params[paramId] ?? 0;
      const sy = e.clientY;
      const onMove = (ev: PointerEvent) => {
        const v = Math.min(1, Math.max(-1, start + (sy - ev.clientY) / 80));
        appState.setParam(view.instance.id, paramId, v);
        view.tooltip.showNow([`${i + 1}→${j + 1}: ${v.toFixed(2)}`], ev.clientX, ev.clientY);
        this.draw(view);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        view.tooltip.hide();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    hit.on('pointerover', (e) =>
      view.tooltip.show(
        ['Mod matrix', 'Rows: inputs. Columns: outputs. Drag a cell up/down to set depth (±1); double-click zeroes it.'],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => view.tooltip.hide());
    view.addChild(hit);
  }

  private draw(view: ModuleView): void {
    if (!this.g) return;
    const { x, y, w, h } = this.rect;
    const n = MODMATRIX_SIZE;
    const cw = w / n;
    const ch = h / n;
    const g = this.g;
    g.clear();
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const cx = x + j * cw;
        const cy = y + i * ch;
        const amt = view.instance.params[`m${i + 1}${j + 1}`] ?? 0;
        g.roundRect(cx + 1, cy + 1, cw - 2, ch - 2, 3).fill(theme.inset);
        if (Math.abs(amt) > 0.005) {
          // Bar grows from the cell's vertical center: up = +, down = −.
          const mid = cy + ch / 2;
          const barH = (Math.abs(amt) * (ch - 6)) / 2;
          g.roundRect(
            cx + 3,
            amt > 0 ? mid - barH : mid,
            cw - 6,
            barH,
            2,
          ).fill(amt > 0 ? view.accent() : 0x52e07a);
        } else {
          g.circle(cx + cw / 2, cy + ch / 2, 1.5).fill(theme.textDim);
        }
      }
    }
  }
}
