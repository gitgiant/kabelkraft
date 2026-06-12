/**
 * Per-container display settings — VISUALIZER_ENGINE_PLAN.md Phase 6.
 * Rate cap (vsync divider) + resolution scale live in the visualizer
 * module's `data` next to `graph`, so they serialize with the project.
 * Pure data + arithmetic: no GPU/DOM, unit-testable in node.
 */

/** Locked frame-rate caps (Hz). rAF can't exceed the display rate, so 240 is "uncapped" on slower panels. */
export const VIS_RATES = [60, 120, 144, 240] as const;

/** Backing-store multipliers over CSS size. */
export const VIS_RES_SCALES = [1, 0.75, 0.5, 0.25] as const;

export interface VisDisplay {
  fps: number;
  res: number;
}

/** Read a container's display settings, defaulting and rejecting foreign data. */
export function visDisplayOf(data: Record<string, unknown> | undefined): VisDisplay {
  const fps = Number(data?.fps);
  const res = Number(data?.res);
  return {
    fps: (VIS_RATES as readonly number[]).includes(fps) ? fps : 60,
    res: (VIS_RES_SCALES as readonly number[]).includes(res) ? res : 1,
  };
}

/**
 * rAF rate gate — the per-container vsync divider. rAF fires at the display
 * rate; due() says whether this callback should render to hold `fps`. The
 * 3 ms slack absorbs vsync jitter so a 60 fps cap on a 60 Hz display passes
 * every callback instead of every other one.
 */
export class FrameGate {
  private last = 0;

  due(nowMs: number, fps: number): boolean {
    const interval = 1000 / fps;
    const elapsed = nowMs - this.last;
    if (elapsed < interval - 3) return false;
    // Snap to the grid rather than to `nowMs` so jitter doesn't accumulate;
    // a slack-early pass (elapsed < interval) must not leave `last` behind.
    this.last = nowMs - (Math.max(0, elapsed - interval) % interval);
    return true;
  }
}
