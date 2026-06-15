import { Graphics, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { KEYS, type ModuleView, type ParamFaceCtx, type ParamFaceOpts } from '../ModuleView';
import type { Meter } from './meters';
import type { FaceRenderer } from './types';

/**
 * Shared param-grid face: the default tile for every module that is just a
 * knob/selector band, optionally with an edge meter rail or a bottom device
 * row (audio/MIDI ports, compressor gain-reduction meter, …). When the tile
 * has a rail meter, the face holds it and drives it from `live()`.
 */
export class ParamFace implements FaceRenderer {
  private meter: Meter | null = null;

  constructor(private readonly opts: ParamFaceOpts = {}) {}

  build(view: ModuleView): void {
    this.meter = view.buildParamFace(this.opts);
  }

  live(view: ModuleView): void {
    this.meter?.update(view);
  }
}

/** Keyboard: a param band over one octave of clickable keys (C–B). */
export class KeyboardFace implements FaceRenderer {
  build(view: ModuleView): void {
    view.buildParamFace({ display: (c) => this.buildKeys(view, c.x, c.top + c.band + 4, c.gw) });
  }

  private buildKeys(view: ModuleView, x: number, y: number, w: number): void {
    const keyW = w / KEYS.length;
    const keyH = Math.max(30, view.h - y - 12);
    KEYS.forEach((key, i) => {
      const g = new Graphics()
        .roundRect(0, 0, keyW - 2, key.black ? keyH * 0.6 : keyH, 3)
        .fill(key.black ? 0x1a1a20 : 0xe8e8ee);
      g.position.set(x + i * keyW, y);
      g.eventMode = 'static';
      g.cursor = 'pointer';
      const id = `kbd:${key.semitone}`;
      const pitch = () => 60 + key.semitone + Math.round(view.instance.params.octave ?? 0) * 12;
      g.on('pointerdown', (e) => {
        e.stopPropagation();
        appState.noteOn(view.instance.id, id, pitch());
      });
      const off = () => appState.noteOff(view.instance.id, id);
      g.on('pointerup', off);
      g.on('pointerupoutside', off);
      g.on('pointerout', off);
      view.addChild(g);
    });
  }
}

/** Transport: a param band over rewind/play/pause/stop transport buttons. */
export class TransportFace implements FaceRenderer {
  build(view: ModuleView): void {
    view.buildParamFace({
      display: (c: ParamFaceCtx) => this.buildButtons(view, view.w / 2 - 84, c.top + c.band + 10),
    });
  }

  private buildButtons(view: ModuleView, x: number, y: number): void {
    const buttons: Array<['⏮', 'rewind'] | ['▶', 'play'] | ['⏸', 'pause'] | ['⏹', 'stop']> = [
      ['⏮', 'rewind'], ['▶', 'play'], ['⏸', 'pause'], ['⏹', 'stop'],
    ];
    buttons.forEach(([icon, cmd], i) => {
      const g = new Graphics().roundRect(0, 0, 36, 26, 5).fill(theme.button);
      g.position.set(x + i * 42, y);
      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.on('pointerdown', (e) => {
        e.stopPropagation();
        appState.transportCommand(cmd);
      });
      view.addChild(g);
      const t = new Text({ text: icon, style: { fontSize: 13, fill: theme.text } });
      t.anchor.set(0.5);
      t.position.set(x + i * 42 + 18, y + 13);
      t.eventMode = 'none';
      view.addChild(t);
    });
  }
}
