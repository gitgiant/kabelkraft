import { Graphics, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { MODULE_TITLE_H, type ModuleView } from '../ModuleView';
import type { VMeter } from './meters';
import type { FaceRenderer } from './types';

/** Recorder: a REC/STOP toggle + elapsed-time readout beside a peak meter,
 * all driven from live(). */
export class RecorderFace implements FaceRenderer {
  private button: Graphics | null = null;
  private label: Text | null = null;
  private elapsed: Text | null = null;
  private meter: VMeter | null = null;
  private rect = { x: 0, y: 0 };

  build(view: ModuleView): void {
    this.buildButton(view, 10, MODULE_TITLE_H + 10, view.w - 56);
    this.meter = view.buildVMeter(view.w - 32, MODULE_TITLE_H + 18, 14, view.h - MODULE_TITLE_H - 32);
  }

  live(view: ModuleView): void {
    this.meter?.update(view);
    if (!this.elapsed) return;
    const recording = appState.isRecording(view.instance.id);
    this.elapsed.text = recording
      ? `${appState.recordingSeconds(view.instance.id).toFixed(1)} s`
      : appState.lastRecordingSeconds > 0
        ? `saved ${appState.lastRecordingSeconds.toFixed(1)} s`
        : '0.0 s';
    // Keep the button in sync if recording was toggled elsewhere.
    this.drawButton(view);
  }

  private buildButton(view: ModuleView, x: number, y: number, _w: number): void {
    this.rect = { x, y };
    this.button = new Graphics();
    view.addChild(this.button);

    this.label = new Text({ text: '', style: { fontSize: 12, fill: theme.text, fontWeight: 'bold' } });
    this.label.anchor.set(0.5);
    this.label.position.set(x + 45, y + 15);
    this.label.eventMode = 'none';
    view.addChild(this.label);

    this.elapsed = new Text({ text: '0.0 s', style: { fontSize: 12, fill: theme.textDim } });
    this.elapsed.anchor.set(0, 0);
    this.elapsed.position.set(x, y + 38);
    view.addChild(this.elapsed);

    const hit = new Graphics().rect(x, y, 90, 30).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.toggleRecord(view.instance.id);
      this.drawButton(view);
    });
    hit.on('pointerover', (e) =>
      view.tooltip.show(
        ['Recorder', 'Records incoming audio; stopping downloads a WAV file.'],
        e.clientX,
        e.clientY,
      ),
    );
    hit.on('pointerout', () => view.tooltip.hide());
    view.addChild(hit);
    this.drawButton(view);
  }

  private drawButton(view: ModuleView): void {
    if (!this.button || !this.label) return;
    const recording = appState.isRecording(view.instance.id);
    const { x, y } = this.rect;
    this.button
      .clear()
      .roundRect(x, y, 90, 30, 6)
      .fill(recording ? 0xaa2020 : theme.button)
      .stroke({ width: 1, color: recording ? 0xff5050 : 0x4a4a58 });
    this.label.text = recording ? '■ STOP' : '● REC';
  }
}
