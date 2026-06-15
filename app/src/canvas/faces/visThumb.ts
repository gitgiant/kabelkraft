import { Texture } from 'pixi.js';
import { appState } from '../../state';
import { ContainerRenderer, graphSupported } from '../../visual/runtime';

/**
 * Shared GPU tile thumbnails: one offscreen renderer per visualizer module,
 * reused across tile rebuilds, updated at ¼ ticker rate. Pruned on delete.
 */
export interface VisThumb {
  canvas: OffscreenCanvas;
  renderer: ContainerRenderer | null;
  texture: Texture;
  failed: boolean;
}

const visThumbs = new Map<string, VisThumb>();
let visThumbPruner = false;

export function visThumb(moduleId: string, aspect: number): VisThumb {
  if (!visThumbPruner) {
    visThumbPruner = true;
    appState.on('graphChanged', () => {
      for (const [id, t] of visThumbs) {
        if (!appState.graph.modules.has(id)) {
          t.renderer?.destroy();
          t.texture.destroy(true);
          visThumbs.delete(id);
        }
      }
    });
  }
  let t = visThumbs.get(moduleId);
  if (!t) {
    const canvas = new OffscreenCanvas(256, Math.max(64, Math.min(512, Math.round(256 * aspect))));
    t = { canvas, renderer: null, texture: Texture.from(canvas), failed: false };
    visThumbs.set(moduleId, t);
    void ContainerRenderer.create(canvas).then((r) => {
      const entry = visThumbs.get(moduleId);
      if (entry === t) {
        t!.renderer = r;
        t!.failed = r === null;
      } else r?.destroy();
    });
  }
  return t;
}

/** Keep a tint source rendering while its tile is hidden (collapsed group) —
 * otherwise the derived tint would freeze at its last sampled color. */
const hiddenTintTick = new Map<string, number>();

export function tickHiddenTintSource(moduleId: string): void {
  const now = performance.now();
  if (now - (hiddenTintTick.get(moduleId) ?? 0) < 66) return;
  hiddenTintTick.set(moduleId, now);
  const thumb = visThumb(moduleId, 0.66);
  if (!thumb.renderer) return;
  const frame = appState.visFrame(moduleId);
  if (frame && graphSupported(frame.graph)) {
    thumb.renderer.render(frame);
  }
}
