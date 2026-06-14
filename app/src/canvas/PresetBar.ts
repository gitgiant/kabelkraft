/**
 * Title-bar preset picker — PRESETS_PLAN.md (UI, option B).
 *
 * Renders `◀ PresetName ▶` into a module/group title bar. The name (with a
 * trailing `*` when dirty) opens the preset menu popup; the arrows step the
 * flat preset list, wrapping. A self-contained Container: it subscribes to the
 * relevant AppState events and redraws in place, and unsubscribes on destroy
 * (the parent view destroys it on every rebuild, so no leaks).
 */

import { Container, Graphics, Text } from 'pixi.js';
import { appState } from '../state';
import type { PresetTarget } from '../core/preset';
import { theme } from '../theme';
import type { Tooltip } from './Tooltip';

/** Accent used for a dirty (unsaved) preset name. */
const DIRTY_COLOR = 0xffb13d;

export interface PresetBarOpts {
  target: PresetTarget;
  /** Right edge (parent coords) where the picker ends — just left of glyphs. */
  rightX: number;
  /** Title-bar top y. */
  y: number;
  /** Max preset-name width before ellipsizing (px). */
  maxNameW?: number;
  tooltip: Tooltip;
}

/** Ellipsize a string to fit `maxW` at the title font, returning a Text. */
export function fitText(str: string, maxW: number, fill: number): Text {
  const style = { fontSize: 12, fill, fontWeight: 'bold' as const };
  let text = new Text({ text: str, style });
  if (text.width <= maxW) return text;
  let s = str;
  while (s.length > 1 && text.width > maxW) {
    s = s.slice(0, -1);
    text.destroy();
    text = new Text({ text: `${s}…`, style });
  }
  return text;
}

export class PresetBar extends Container {
  private unsubs: Array<() => void> = [];
  /** Last-rendered signature — skip the rebuild when nothing visible changed. */
  private lastSig = '';

  constructor(private opts: PresetBarOpts) {
    super();
    this.redraw();
    const refresh = () => this.redraw();
    this.unsubs.push(appState.on('presetsChanged', refresh));
    this.unsubs.push(appState.on('paramChanged', refresh));
  }

  override destroy(options?: Parameters<Container['destroy']>[0]): void {
    for (const off of this.unsubs) off();
    this.unsubs = [];
    super.destroy(options);
  }

  private redraw(): void {
    const { target, rightX, y, tooltip } = this.opts;
    const maxNameW = this.opts.maxNameW ?? 90;
    const dirty = appState.isPresetDirty(target);
    const name = appState.presetDisplayName(target) + (dirty ? ' *' : '');
    const canStep = appState.presetsOf(target).length >= 2;

    // Most paramChanged events (dragging another tile's dial) don't change what
    // this bar shows — bail before churning Text objects.
    const sig = `${name}|${dirty}|${canStep}|${rightX}|${maxNameW}`;
    if (sig === this.lastSig && this.children.length > 0) return;
    this.lastSig = sig;

    for (const c of this.removeChildren()) c.destroy({ children: true });

    // ▶ right arrow.
    const right = new Text({ text: '▸', style: { fontSize: 12, fill: canStep ? theme.text : theme.textDim } });
    right.anchor.set(1, 0);
    right.position.set(rightX, y);
    this.addChild(right);

    // Name (clickable → menu), to the left of ▶.
    const nameRight = rightX - 14;
    const nameText = fitText(name, maxNameW, dirty ? DIRTY_COLOR : theme.text);
    nameText.anchor.set(1, 0);
    nameText.position.set(nameRight, y);
    this.addChild(nameText);
    const nameLeft = nameRight - nameText.width;

    // ◀ left arrow, to the left of the name.
    const left = new Text({ text: '◂', style: { fontSize: 12, fill: canStep ? theme.text : theme.textDim } });
    left.anchor.set(1, 0);
    left.position.set(nameLeft - 6, y);
    this.addChild(left);

    // Hit zones.
    const arrowHit = (cx: number, dir: 1 | -1, tip: string): void => {
      const hit = new Graphics().rect(cx - 12, y - 3, 14, 20).fill({ color: 0xffffff, alpha: 0.001 });
      hit.eventMode = 'static';
      hit.cursor = canStep ? 'pointer' : 'default';
      hit.on('pointerdown', (e) => {
        e.stopPropagation();
        if (canStep) appState.stepPreset(target, dir);
      });
      hit.on('pointerover', (e) => tooltip.show([tip], e.clientX, e.clientY));
      hit.on('pointerout', () => tooltip.hide());
      this.addChild(hit);
    };
    arrowHit(rightX, 1, 'Next preset');
    arrowHit(nameLeft - 6, -1, 'Previous preset');

    const nameHit = new Graphics()
      .rect(nameLeft - 2, y - 3, nameText.width + 4, 20)
      .fill({ color: 0xffffff, alpha: 0.001 });
    nameHit.eventMode = 'static';
    nameHit.cursor = 'pointer';
    nameHit.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.ensureDefaultPreset(target);
      appState.openPresetMenu(target, e.clientX, e.clientY);
    });
    nameHit.on('pointerover', (e) => tooltip.show(['Presets', 'Click to save, load or generate presets.'], e.clientX, e.clientY));
    nameHit.on('pointerout', () => tooltip.hide());
    this.addChild(nameHit);
  }
}
