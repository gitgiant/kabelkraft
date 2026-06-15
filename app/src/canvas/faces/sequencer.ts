import { FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { SEQ_PITCH_MAX, SEQ_PITCH_MIN, type SeqStep } from '../../core/registry';
import type { ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/** Rows visible in the pitch grid (one octave). */
const SEQ_GRID_ROWS = 12;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(pitch: number): string {
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

/** Sequencer: a pitch × step grid (click/drag to paint) with a live playhead. */
export class StepGridFace implements FaceRenderer {
  private g: Graphics | null = null;
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private lastStep = -1;

  build(view: ModuleView): void {
    view.buildParamFace({ display: (c) => this.buildGrid(view, c.x, c.top + c.band + 6, c.gw) });
  }

  live(view: ModuleView): void {
    if (!this.g) return;
    const step = appState.seqSteps[view.instance.id] ?? -1;
    const current = appState.transport.playing ? step : -1;
    if (current !== this.lastStep) {
      this.lastStep = current;
      this.draw(view, current);
    }
  }

  private steps(view: ModuleView): SeqStep[] {
    return (view.instance.data?.steps as SeqStep[]) ?? [];
  }

  /** Lowest pitch of the visible grid window — stored, else fit to pattern. */
  private gridLo(view: ModuleView): number {
    const maxLo = SEQ_PITCH_MAX - SEQ_GRID_ROWS + 1;
    const stored = Number(view.instance.data?.gridLo);
    if (Number.isFinite(stored) && stored > 0) {
      return Math.min(maxLo, Math.max(SEQ_PITCH_MIN, Math.round(stored)));
    }
    const on = this.steps(view).filter((s) => s.on).map((s) => s.pitch);
    const lo = on.length ? Math.min(...on) : 57;
    return Math.min(maxLo, Math.max(SEQ_PITCH_MIN, lo));
  }

  private buildGrid(view: ModuleView, x: number, y: number, w: number): void {
    const h = Math.max(30, view.h - y - 12);
    const gridW = w - 16; // room for the pitch-window shift buttons
    this.rect = { x, y, w: gridW, h };
    this.g = new Graphics();
    view.addChild(this.g);
    this.draw(view, -1);

    const hit = new Graphics().rect(x, y, gridW, h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      this.beginEdit(view, e);
    });
    hit.on('pointerover', (e) =>
      view.tooltip.show(
        ['Steps', 'Rows are pitches. Click a tile to set it, click again to clear; drag to paint. ▲▼ shift the octave window.'],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => view.tooltip.hide());
    view.addChild(hit);

    // Pitch-window shift buttons (right edge).
    const shift = (glyph: string, by: number, ty: number) => {
      const t = new Text({ text: glyph, style: { fontSize: 10, fill: theme.textDim } });
      t.anchor.set(0.5, 0.5);
      t.position.set(x + w - 7, ty);
      t.eventMode = 'static';
      t.cursor = 'pointer';
      t.hitArea = { contains: (px, py) => Math.abs(px) < 10 && Math.abs(py) < 12 };
      t.on('pointerdown', (e) => {
        e.stopPropagation();
        const maxLo = SEQ_PITCH_MAX - SEQ_GRID_ROWS + 1;
        const next = Math.min(maxLo, Math.max(SEQ_PITCH_MIN, this.gridLo(view) + by));
        appState.setModuleData(view.instance.id, 'gridLo', next);
        this.draw(view, this.lastStep);
      });
      t.on('pointerover', (e) =>
        view.tooltip.show([`Shift pitch window ${by > 0 ? 'up' : 'down'}`], e.clientX, e.clientY),
      );
      t.on('pointerout', () => view.tooltip.hide());
      view.addChild(t);
    };
    shift('▲', 1, y + 8);
    shift('▼', -1, y + h - 8);
  }

  private indexAt(view: ModuleView, localX: number): number {
    const { x, w } = this.rect;
    const steps = this.steps(view);
    return Math.min(steps.length - 1, Math.max(0, Math.floor(((localX - x) / w) * steps.length)));
  }

  /** Pitch of the grid row under a tile-local y (rows top→bottom = high→low). */
  private pitchAt(view: ModuleView, localY: number): number {
    const { y, h } = this.rect;
    const rows = SEQ_GRID_ROWS;
    const row = Math.min(rows - 1, Math.max(0, Math.floor(((localY - y) / h) * rows)));
    return this.gridLo(view) + (rows - 1 - row);
  }

  private beginEdit(view: ModuleView, e: FederatedPointerEvent): void {
    appState.beginUndoable();
    const steps = this.steps(view);
    const first = view.toLocal(e.global);
    const firstIdx = this.indexAt(view, first.x);
    const firstPitch = this.pitchAt(view, first.y);
    const firstStep = steps[firstIdx];
    if (!firstStep) return;
    // Clicking a step's lit tile erases; anything else paints (and dragging
    // continues in the same mode, painting/erasing every tile crossed).
    const erase = firstStep.on && firstStep.pitch === firstPitch;

    const commit = () => {
      appState.setModuleData(view.instance.id, 'steps', [...steps]);
      this.draw(view, this.lastStep);
    };
    const apply = (localX: number, localY: number, clientX: number, clientY: number) => {
      const idx = this.indexAt(view, localX);
      const pitch = this.pitchAt(view, localY);
      const step = steps[idx];
      if (!step) return;
      if (erase) {
        step.on = false;
      } else {
        step.on = true;
        step.pitch = pitch;
        view.tooltip.showNow([noteName(pitch)], clientX, clientY);
      }
      commit();
    };
    apply(first.x, first.y, e.clientX, e.clientY);

    const scale = view.worldTransform.a || 1;
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: PointerEvent) => {
      apply(first.x + (ev.clientX - sx) / scale, first.y + (ev.clientY - sy) / scale, ev.clientX, ev.clientY);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      view.tooltip.hide();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private draw(view: ModuleView, playhead: number): void {
    if (!this.g) return;
    const { x, y, w, h } = this.rect;
    const steps = this.steps(view);
    if (steps.length === 0) return;
    const rows = SEQ_GRID_ROWS;
    const lo = this.gridLo(view);
    const hi = lo + rows - 1;
    const cellW = w / steps.length;
    const cellH = h / rows;
    const g = this.g;
    g.clear();
    for (let i = 0; i < steps.length; i++) {
      const cx = x + i * cellW;
      const step = steps[i];
      for (let r = 0; r < rows; r++) {
        const pitch = lo + (rows - 1 - r);
        const cy = y + r * cellH;
        const isC = pitch % 12 === 0;
        g.roundRect(cx + 1, cy + 0.5, cellW - 2, cellH - 1, 2)
          .fill({ color: theme.inset, alpha: isC ? 0.6 : 1 });
        if (step.on && step.pitch === pitch) {
          g.roundRect(cx + 1.5, cy + 1, cellW - 3, cellH - 2, 2)
            .fill(i === playhead ? 0x7fe9ff : 0x3dd9ff);
        }
      }
      // Active step outside the visible window: edge marker.
      if (step.on && step.pitch > hi) {
        g.moveTo(cx + cellW / 2 - 3, y + 6).lineTo(cx + cellW / 2 + 3, y + 6)
          .lineTo(cx + cellW / 2, y + 1).closePath().fill(0x3dd9ff);
      } else if (step.on && step.pitch < lo) {
        g.moveTo(cx + cellW / 2 - 3, y + h - 6).lineTo(cx + cellW / 2 + 3, y + h - 6)
          .lineTo(cx + cellW / 2, y + h - 1).closePath().fill(0x3dd9ff);
      }
      if (i === playhead) {
        g.roundRect(cx + 1, y, cellW - 2, h, 2).fill({ color: 0xffffff, alpha: 0.12 });
      }
    }
  }
}
