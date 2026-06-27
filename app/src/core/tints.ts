/**
 * Derived-tint engine — the frame-color → UI-accent system, lifted out of
 * AppState so its color math, easing, and nearest-source resolution live (and
 * test) in one place.
 *
 * The visual runtime averages each visualizer's frame into a single RGB and
 * pushes it in via `sample()`. Modules and groups can subscribe to a tint by
 * wiring a `visual` wire into a `tint` endpoint (a module tint port or a group
 * intrinsic pole) or by binding a face element's `tintSourceId`. The displayed
 * colour eases toward the latest sample so accents glide rather than snap.
 *
 * The graph is read lazily through `getGraph()` because AppState swaps its
 * `graph` instance wholesale on project load / undo — capturing it once would
 * leave the engine resolving against a stale graph after an undo.
 */

import type { Graph } from './graph';
import { hslToRgbInt, rgbIntToHsl } from './color';

/** Minimum displayed luminance (0–1) so a near-black frame stays readable. */
const MIN_TINT_LUM = 0.22;
/** Ease time constant in ms (~150 ms to settle). */
const EASE_TAU = 150;

export class TintEngine {
  /** Smoothed displayed colours (packed 24-bit RGB) per visual-source module. */
  readonly values: Record<string, number> = {};
  /** Raw sampled targets (luminance-clamped); `values` eases toward these. */
  private targets: Record<string, number> = {};
  /** Cached "who needs a tint" set; invalidated on structural changes. */
  private sourcesCache: Set<string> | null = null;

  constructor(private readonly getGraph: () => Graph) {}

  /** Drop the cached source set; call on any structural (graph) change. */
  invalidate(): void {
    this.sourcesCache = null;
  }

  /** Visual sources consumed as a tint: wires into `tint` endpoints (module
   * ports and group intrinsic poles) plus face-element bindings. */
  sourceIds(): Set<string> {
    if (!this.sourcesCache) {
      const graph = this.getGraph();
      const s = new Set<string>();
      for (const w of graph.wires.values()) {
        if (w.type === 'visual' && w.to.portId === 'tint') s.add(w.from.moduleId);
      }
      for (const g of graph.groups.values()) {
        for (const el of g.face?.elements ?? []) {
          if (el.tintSourceId) s.add(el.tintSourceId);
        }
      }
      this.sourcesCache = s;
    }
    return this.sourcesCache;
  }

  /** Is this id wired/bound as a tint source? (Gates the sampler.) */
  wanted(id: string): boolean {
    return this.sourceIds().has(id);
  }

  /** Sampler callback: clamp to a readable luminance and set the ease target. */
  sample(id: string, rgb: number): void {
    if (!this.wanted(id)) return;
    const { h, s, l } = rgbIntToHsl(rgb);
    this.targets[id] = l < MIN_TINT_LUM ? hslToRgbInt(h, s, MIN_TINT_LUM) : rgb;
  }

  /** Source module feeding a tint endpoint (module tint port or group pole). */
  private wireInto(id: string): string | null {
    for (const w of this.getGraph().wires.values()) {
      if (w.type === 'visual' && w.to.moduleId === id && w.to.portId === 'tint') {
        return w.from.moduleId;
      }
    }
    return null;
  }

  /** Nearest tint source for a module: own tint port, then enclosing groups
   * inside-out (nearest wired ancestor wins). Null = default accent. */
  sourceFor(moduleId: string): string | null {
    const own = this.wireInto(moduleId);
    if (own) return own;
    const graph = this.getGraph();
    let group = graph.groupOfModule(moduleId);
    while (group) {
      const src = this.wireInto(group.id);
      if (src) return src;
      group = graph.parentGroup(group.id);
    }
    return null;
  }

  /** Nearest tint source for a group: its own pole, then ancestors. */
  sourceForGroup(groupId: string): string | null {
    const graph = this.getGraph();
    let group = graph.groups.get(groupId);
    while (group) {
      const src = this.wireInto(group.id);
      if (src) return src;
      group = graph.parentGroup(group.id);
    }
    return null;
  }

  /** Resolved tint colour for a module, if any source is wired and sampled. */
  tintFor(moduleId: string): number | null {
    const src = this.sourceFor(moduleId);
    return src ? (this.values[src] ?? null) : null;
  }

  /** Resolved tint colour for a group tile/face, if any. */
  tintForGroup(groupId: string): number | null {
    const src = this.sourceForGroup(groupId);
    return src ? (this.values[src] ?? null) : null;
  }

  /** Ease displayed tints toward their targets; canvas calls per frame. */
  tick(dtMs: number): void {
    const wanted = this.sourceIds();
    const graph = this.getGraph();
    const k = 1 - Math.exp(-dtMs / EASE_TAU);
    for (const id of Object.keys(this.targets)) {
      if (!wanted.has(id) || !graph.modules.has(id)) {
        delete this.targets[id];
        delete this.values[id];
        continue;
      }
      const target = this.targets[id];
      const cur = this.values[id];
      if (cur === undefined) {
        this.values[id] = target;
        continue;
      }
      const lerp = (a: number, b: number) => Math.round(a + (b - a) * k);
      this.values[id] =
        (lerp((cur >> 16) & 0xff, (target >> 16) & 0xff) << 16) |
        (lerp((cur >> 8) & 0xff, (target >> 8) & 0xff) << 8) |
        lerp(cur & 0xff, target & 0xff);
    }
  }
}
