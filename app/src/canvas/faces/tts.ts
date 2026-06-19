import { Graphics, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import type { ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';
import { TTS_VOICES, DEFAULT_VOICE_ID, voiceById } from '../../core/tts/voices';

/** "loading model 42%" from a {message, fraction} progress record. */
function fmtProgress(p: { message: string; fraction: number }): string {
  const pct = p.fraction > 0 ? ` ${Math.round(p.fraction * 100)}%` : '';
  return `${p.message}${pct}`;
}

/**
 * Text to Speech face: a voice/accent selector, the editable text line, and
 * Generate / Speak buttons over the standard param band. Synthesis state
 * (busy/error/ready) is mirrored from state each frame in live().
 */
export class TtsFace implements FaceRenderer {
  private voiceLine: Text | null = null;
  private textLine: Text | null = null;
  private status: Text | null = null;
  private genBtn: Graphics | null = null;
  private genLabel: Text | null = null;
  private speakBtn: Graphics | null = null;
  private speakLabel: Text | null = null;
  private gen = { x: 0, y: 0, w: 0, h: 26 };
  private spk = { x: 0, y: 0, w: 0, h: 26 };

  build(view: ModuleView): void {
    view.buildParamFace({
      display: (c) => this.buildBody(view, c.x, c.top + c.band + 4, c.gw),
    });
  }

  live(view: ModuleView): void {
    if (this.textLine) this.update(view);
  }

  private currentVoiceId(view: ModuleView): string {
    return (view.instance.data?.voiceId as string) || DEFAULT_VOICE_ID;
  }

  private buildBody(view: ModuleView, x: number, y: number, w: number): void {
    const bg = new Graphics().roundRect(x, y, w, view.h - y - 12, 4).fill(theme.graphBg);
    view.addChild(bg);

    // Voice / accent selector — click cycles through the catalog.
    this.voiceLine = new Text({ text: '', style: { fontSize: 11, fill: theme.text } });
    this.voiceLine.position.set(x + 8, y + 6);
    this.voiceLine.eventMode = 'static';
    this.voiceLine.cursor = 'pointer';
    this.voiceLine.on('pointerdown', (e) => {
      e.stopPropagation();
      const ids = TTS_VOICES.map((v) => v.id);
      const i = ids.indexOf(this.currentVoiceId(view));
      appState.setTtsVoice(view.instance.id, ids[(i + 1) % ids.length]);
      this.update(view);
    });
    this.voiceLine.on('pointerover', (e) =>
      view.tooltip.show(['Voice', 'Click to cycle voice / accent. Models download on first use.'], e.clientX, e.clientY),
    );
    this.voiceLine.on('pointerout', () => view.tooltip.hide());
    view.addChild(this.voiceLine);

    // Editable text line.
    this.textLine = new Text({
      text: '',
      style: { fontSize: 13, fill: 0xe8e8ee, wordWrap: true, wordWrapWidth: w - 16 },
    });
    this.textLine.position.set(x + 8, y + 26);
    this.textLine.eventMode = 'static';
    this.textLine.cursor = 'text';
    this.textLine.on('pointerdown', (e) => {
      e.stopPropagation();
      const last = (view.instance.data?.text as string) ?? '';
      const text = window.prompt('Text to speak', last);
      if (text !== null) appState.setTtsText(view.instance.id, text);
      this.update(view);
    });
    this.textLine.on('pointerover', (e) =>
      view.tooltip.show(['Text', 'Click to type what the voice should say, then Generate.'], e.clientX, e.clientY),
    );
    this.textLine.on('pointerout', () => view.tooltip.hide());
    view.addChild(this.textLine);

    // Buttons row, near the bottom of the panel.
    const btnY = view.h - 46;
    const half = (w - 24) / 2;
    this.gen = { x: x + 8, y: btnY, w: half, h: 26 };
    this.spk = { x: x + 16 + half, y: btnY, w: half, h: 26 };

    this.genBtn = new Graphics();
    view.addChild(this.genBtn);
    this.genLabel = this.btnLabel(view, this.gen);
    this.speakBtn = new Graphics();
    view.addChild(this.speakBtn);
    this.speakLabel = this.btnLabel(view, this.spk);

    this.hit(view, this.gen, () => void appState.generateTts(view.instance.id), [
      'Generate',
      'Synthesize the text into a playable buffer.',
    ]);
    this.hit(view, this.spk, () => appState.speakTts(view.instance.id), [
      'Speak',
      'Play the synthesized speech at the root note.',
    ]);

    // Status line just above the buttons.
    this.status = new Text({ text: '', style: { fontSize: 10, fill: theme.textDim } });
    this.status.position.set(x + 8, btnY - 16);
    view.addChild(this.status);

    this.update(view);
  }

  private btnLabel(view: ModuleView, r: { x: number; y: number; w: number; h: number }): Text {
    const t = new Text({ text: '', style: { fontSize: 12, fill: theme.text, fontWeight: 'bold' } });
    t.anchor.set(0.5);
    t.position.set(r.x + r.w / 2, r.y + r.h / 2);
    t.eventMode = 'none';
    view.addChild(t);
    return t;
  }

  private hit(
    view: ModuleView,
    r: { x: number; y: number; w: number; h: number },
    onClick: () => void,
    tip: [string, string],
  ): void {
    const hit = new Graphics().rect(r.x, r.y, r.w, r.h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', (e) => {
      e.stopPropagation();
      onClick();
      this.update(view);
    });
    hit.on('pointerover', (e) => view.tooltip.show(tip, e.clientX, e.clientY));
    hit.on('pointerout', () => view.tooltip.hide());
    view.addChild(hit);
  }

  private update(view: ModuleView): void {
    if (!this.voiceLine || !this.textLine || !this.status || !this.genBtn || !this.speakBtn) return;
    const id = view.instance.id;
    const voice = voiceById(this.currentVoiceId(view));
    this.voiceLine.text = voice ? `🗣 ${voice.name} · ${voice.accent}` : '🗣 (no voice)';

    const text = (view.instance.data?.text as string) ?? '';
    this.textLine.text = text || 'click to type text…';
    this.textLine.alpha = text ? 1 : 0.5;

    const busy = appState.ttsBusy(id);
    const err = appState.ttsError(id);
    const dl = appState.ttsProgress(id);
    const ready = appState.samples.has(id) && (view.instance.data?.generated as boolean);
    this.status.text = dl
      ? `⬇ downloading voice ${fmtProgress(dl)}`
      : busy
        ? '⏳ synthesizing…'
        : err
          ? `⚠ ${err}`
          : ready
            ? '✓ ready — Speak or play notes'
            : text
              ? 'press Generate'
              : '';
    this.status.style.fill = err ? 0xff8866 : theme.textDim;

    // Generate button: disabled while busy or with no text.
    const genOn = !busy && text.trim().length > 0;
    this.drawBtn(this.genBtn, this.gen, genOn, busy ? theme.button : theme.button);
    if (this.genLabel) {
      this.genLabel.text = busy ? '…' : 'Generate';
      this.genLabel.alpha = genOn ? 1 : 0.4;
    }
    // Speak button: enabled once a buffer exists.
    const spkOn = appState.samples.has(id);
    this.drawBtn(this.speakBtn, this.spk, spkOn, 0x2a6a3a);
    if (this.speakLabel) {
      this.speakLabel.text = '▶ Speak';
      this.speakLabel.alpha = spkOn ? 1 : 0.4;
    }
  }

  private drawBtn(
    g: Graphics,
    r: { x: number; y: number; w: number; h: number },
    on: boolean,
    fill: number,
  ): void {
    g.clear()
      .roundRect(r.x, r.y, r.w, r.h, 6)
      .fill(on ? fill : theme.button)
      .stroke({ width: 1, color: 0x4a4a58 });
  }
}
