import { Graphics, Rectangle, Sprite, Text } from 'pixi.js';
import { appState } from '../../state';
import { theme } from '../../theme';
import { binFrac } from '../../visual/features';
import { approximateScene, visGraphOf } from '../../visual/migrate';
import { graphSupported, webgpuAvailable } from '../../visual/runtime';
import { hslToHex, type ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';
import { visThumb } from './visThumb';

/**
 * Visualizer (PRD §8.5): a param band over a live tile thumbnail of the
 * module's visual graph — a GPU sprite at ¼ rate where WebGPU is available,
 * with a Canvas2D-equivalent approximation as the fallback layer. Double-click
 * opens the graph editor; the ⛶/✎ buttons open the big view / editor.
 */
export class VisualizerFace implements FaceRenderer {
  private g: Graphics | null = null;
  private sprite: Sprite | null = null;
  private tick = 0;
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private particles: Array<{ x: number; y: number; vx: number; vy: number; life: number; hue: number }> = [];

  build(view: ModuleView): void {
    view.buildParamFace({
      display: (c) => this.buildScene(view, c.x, c.top + c.band + 4, c.gw),
    });
  }

  live(view: ModuleView): void {
    if (this.g) this.draw(view);
  }

  private buildScene(view: ModuleView, x: number, y: number, w: number): void {
    const h = view.h - y - 12;
    this.rect = { x, y, w, h };
    const bg = new Graphics().roundRect(x, y, w, h, 4).fill(theme.graphBg);
    // Double-click anywhere on the scene opens the graph editor.
    bg.eventMode = 'static';
    bg.cursor = 'pointer';
    bg.on('pointertap', (e) => {
      if (e.detail === 2) {
        e.stopPropagation();
        appState.openVisEditor(view.instance.id);
      }
    });
    bg.on('pointerover', (e) =>
      view.tooltip.show(['Visualizer scene', 'Double-click to edit the visual graph.'], e.clientX, e.clientY),
    );
    bg.on('pointerout', () => view.tooltip.hide());
    view.addChild(bg);
    if (webgpuAvailable()) {
      // Live GPU thumbnail of the real graph (¼ rate); Graphics stays as a
      // fallback layer while the renderer spins up or when it fails.
      this.sprite = new Sprite(visThumb(view.instance.id, h / w).texture);
      this.sprite.position.set(x, y);
      this.sprite.setSize(w, h);
      this.sprite.eventMode = 'none';
      view.addChild(this.sprite);
    }
    this.g = new Graphics();
    this.g.eventMode = 'none';
    view.addChild(this.g);

    const big = new Text({ text: '⛶', style: { fontSize: 14, fill: theme.textDim } });
    big.anchor.set(1, 0);
    big.position.set(x + w - 4, y + 4);
    big.eventMode = 'static';
    big.cursor = 'pointer';
    big.hitArea = new Rectangle(-20, -4, 26, 26);
    big.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.openVisualizer(view.instance.id);
    });
    big.on('pointerover', (e) =>
      view.tooltip.show(['Big view', 'Opens the resizable visualizer window (fullscreen button inside).'], e.clientX, e.clientY),
    );
    big.on('pointerout', () => view.tooltip.hide());
    view.addChild(big);

    const edit = new Text({ text: '✎', style: { fontSize: 14, fill: theme.textDim } });
    edit.anchor.set(1, 0);
    edit.position.set(x + w - 28, y + 4);
    edit.eventMode = 'static';
    edit.cursor = 'pointer';
    edit.hitArea = new Rectangle(-20, -4, 26, 26);
    edit.on('pointerdown', (e) => {
      e.stopPropagation();
      appState.openVisEditor(view.instance.id);
    });
    edit.on('pointerover', (e) =>
      view.tooltip.show(['Edit visuals', 'Opens the visual graph editor (sources, effects, wiring).'], e.clientX, e.clientY),
    );
    edit.on('pointerout', () => view.tooltip.hide());
    view.addChild(edit);
  }

  /** Cheap screen-bounds test for thumbnail culling (stage is in screen px). */
  private tileOnScreen(view: ModuleView): boolean {
    const gp = view.getGlobalPosition();
    const s = view.worldTransform.a;
    return (
      gp.x + view.w * s > 0 &&
      gp.x < window.innerWidth &&
      gp.y + view.h * s > 0 &&
      gp.y < window.innerHeight
    );
  }

  /**
   * Tile thumbnail — Canvas2D-equivalent approximation of the container's
   * visual graph (first source node wins), driven by the UI-side feature hub.
   * The overlay's no-WebGPU tier draws the same scenes on a 2D canvas.
   */
  private draw(view: ModuleView): void {
    if (!this.g) return;
    if (this.sprite) {
      const thumb = visThumb(view.instance.id, this.rect.h / Math.max(1, this.rect.w));
      if (thumb.renderer) {
        this.g.clear();
        this.sprite.visible = true;
        // ¼ rate, and culled entirely while the tile is off screen.
        if ((this.tick++ & 3) === 0 && this.tileOnScreen(view)) {
          const frame = appState.visFrame(view.instance.id);
          if (frame && graphSupported(frame.graph)) {
            thumb.renderer.render(frame);
            thumb.texture.source.update();
          }
        }
        return;
      }
      this.sprite.visible = false;
      if (!thumb.failed) {
        // Renderer still initializing — draw the approximation meanwhile.
      }
    }
    const f = appState.visFeatures(view.instance.id);
    const { x, y, w, h } = this.rect;
    const g = this.g;
    const { scene, gain: baseGain } = approximateScene(visGraphOf(view.instance.data));
    const ctrl = f && f.ctrl >= 0 ? f.ctrl : 1;
    const gain = baseGain * (0.3 + 0.7 * ctrl);
    g.clear();
    if (!f) return;

    if (scene === 'scope') {
      // Oscilloscope — 256 points sampled from the 1024-sample window.
      const mid = y + h / 2;
      const step = f.wave.length / 256;
      for (let i = 0; i < 256; i++) {
        const v = f.wave[Math.floor(i * step)];
        const px = x + (i / 255) * w;
        const py = mid - Math.max(-1, Math.min(1, v * gain)) * (h / 2 - 4);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke({ width: 1.5, color: 0x3dd9ff, alpha: 0.95 });
    } else if (scene === 'spectrum') {
      // Spectrum bars.
      const n = f.spectrum.length;
      const bw = w / n;
      for (let b = 0; b < n; b++) {
        const frac = binFrac(f.spectrum[b]) * Math.min(1, gain);
        if (frac <= 0.01) continue;
        g.roundRect(x + b * bw + 1, y + h - frac * (h - 6), bw - 2, frac * (h - 6), 1)
          .fill({ color: 0xffb13d, alpha: 0.9 });
      }
    } else {
      // Particles: notes spawn bursts, audio energy feeds drift speed.
      let energy = 0;
      for (const db of f.spectrum) energy = Math.max(energy, binFrac(db));
      for (const pitch of f.notes) {
        const hue = ((pitch % 12) / 12) * 360;
        for (let i = 0; i < 6; i++) {
          this.particles.push({
            x: x + w * ((pitch % 36) / 36),
            y: y + h * 0.7,
            vx: (Math.random() - 0.5) * 3,
            vy: -1 - Math.random() * 2.5,
            life: 1,
            hue,
          });
        }
      }
      if (this.particles.length > 200) this.particles.splice(0, this.particles.length - 200);
      const speed = 0.5 + energy * 2 * gain;
      this.particles = this.particles.filter((p) => {
        p.x += p.vx * speed;
        p.y += p.vy * speed;
        p.vy += 0.04;
        p.life -= 0.02;
        if (p.life <= 0 || p.x < x || p.x > x + w || p.y > y + h) return false;
        const c = hslToHex(p.hue, 0.8, 0.6);
        g.circle(p.x, p.y, 1.5 + p.life * 2.5).fill({ color: c, alpha: p.life });
        return true;
      });
    }
  }
}
