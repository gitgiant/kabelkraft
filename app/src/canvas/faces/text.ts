import { Graphics, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import type { ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/**
 * Text-producer faces (stt/textinput/transporttext/notenames/lyrics): a param
 * band over a panel that mirrors the module's live text output, clickable on
 * the interactive types (start/stop listening, type a line, open lyrics editor).
 */
export class TextFace implements FaceRenderer {
  private line: Text | null = null;
  private status: Text | null = null;

  build(view: ModuleView): void {
    view.buildParamFace({
      display: (c) => this.buildBody(view, c.x, c.top + c.band + 4, c.gw),
    });
  }

  live(view: ModuleView): void {
    if (this.line) this.update(view);
  }

  private buildBody(view: ModuleView, x: number, y: number, w: number): void {
    const h = view.h - y - 12;
    const bg = new Graphics().roundRect(x, y, w, h, 4).fill(theme.graphBg);
    view.addChild(bg);

    this.status = new Text({ text: '', style: { fontSize: 10, fill: theme.textDim } });
    this.status.position.set(x + 8, y + 6);
    view.addChild(this.status);

    this.line = new Text({
      text: '',
      style: { fontSize: 13, fill: 0xe8e8ee, wordWrap: true, wordWrapWidth: w - 16 },
    });
    this.line.position.set(x + 8, y + 24);
    view.addChild(this.line);
    this.update(view);

    const type = view.instance.type;
    if (type === 'stt' || type === 'textinput' || type === 'lyrics') {
      bg.eventMode = 'static';
      bg.cursor = 'pointer';
      bg.on('pointerdown', (e) => {
        e.stopPropagation();
        if (type === 'stt') {
          const on = appState.toggleStt(view.instance.id);
          if (!on && !appState.stt.supported()) {
            view.tooltip.show(['Speech to Text', 'Speech recognition is not available in this browser.'], e.clientX, e.clientY);
          }
        } else if (type === 'lyrics') {
          appState.openLyrics(view.instance.id);
        } else {
          const last = (view.instance.data?.lastText as string) ?? '';
          const text = window.prompt('Text to send', last);
          if (text !== null && text !== '') appState.sendTextInput(view.instance.id, text);
        }
        this.update(view);
      });
      bg.on('pointerover', (e) =>
        view.tooltip.show(
          type === 'stt'
            ? ['Speech to Text', 'Click to start/stop listening (mic permission).']
            : type === 'lyrics'
              ? ['Lyrics', 'Click to open the timed-lyrics editor (AI or hand-write).']
              : ['Text Input', 'Click to type a line; it is sent on OK.'],
          e.clientX,
          e.clientY,
        ),
      );
      bg.on('pointerout', () => view.tooltip.hide());
    }
  }

  /** Per-frame: mirror the module's live text output onto the face. */
  private update(view: ModuleView): void {
    if (!this.line || !this.status) return;
    const type = view.instance.type;
    const ev = appState.textValues[view.instance.id];
    let line = ev?.text ?? '';
    if (!line && type === 'textinput') line = (view.instance.data?.lastText as string) ?? '';
    this.line.text = line || '—';
    this.line.alpha = ev && !ev.final ? 0.6 : 1;
    this.status.text =
      type === 'stt'
        ? appState.stt.active(view.instance.id)
          ? '🎤 listening — click to stop'
          : appState.stt.supported()
            ? '🎤 click to listen'
            : 'speech recognition unavailable'
        : type === 'textinput'
          ? 'click to type'
          : type === 'lyrics'
            ? `${((view.instance.data?.lines as unknown[])?.length ?? 0)} lines · click to edit`
            : type === 'transporttext'
              ? 'transport readout'
              : 'last notes';
  }
}
