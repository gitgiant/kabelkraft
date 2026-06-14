<script lang="ts">
  import { onMount } from 'svelte';
  import { appState } from '../state';
  import { appSettings } from '../core/settings';
  import { FrameGate, clampVisDisplay, visDisplayOf } from '../visual/display';
  import { ContainerRenderer, graphSupported, webgpuAvailable } from '../visual/runtime';

  // Paints the visualizer wired into the active bgvisual's Vis In across the
  // whole canvas area, behind the patch. The PatchCanvas renderer is permanently
  // transparent (grey is its container's CSS background), so this canvas — z 0
  // behind it — simply shows through; opacity 0 hides it when inactive. Driven by
  // its own rAF like the pop-out loop: appState.visFrame(source) → render.
  // WebGPU only; without it the canvas stays hidden (no 2D tier here yet).

  let canvasEl = $state<HTMLCanvasElement>();
  let opacity = $state(0);
  let raf = 0;
  let renderer: ContainerRenderer | null = null;
  let creating = false;
  const gate = new FrameGate();

  async function ensureRenderer(): Promise<void> {
    if (renderer || creating || !canvasEl || !webgpuAvailable()) return;
    creating = true;
    const r = await ContainerRenderer.create(canvasEl);
    creating = false;
    if (r) renderer = r;
  }

  function loop(): void {
    raf = requestAnimationFrame(loop);
    const target = appState.backgroundTarget();
    if (!target) {
      opacity = 0;
      return;
    }
    if (!renderer) {
      void ensureRenderer();
      return; // hidden until the GPU frame is ready
    }
    const mod = appState.graph.modules.get(target.sourceId);
    const cap = appSettings().display;
    const d = clampVisDisplay(visDisplayOf(mod?.data), { fps: cap.visMaxFps, res: cap.visMaxRes });
    if (!gate.due(performance.now(), d.fps)) return;
    const frame = appState.visFrame(target.sourceId);
    if (!frame || !graphSupported(frame.graph)) {
      opacity = 0;
      return;
    }
    renderer.resolutionScale = d.res;
    renderer.render(frame);
    opacity = target.opacity;
  }

  onMount(() => {
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      renderer?.destroy();
      renderer = null;
    };
  });
</script>

<canvas class="bg-vis" bind:this={canvasEl} style="opacity:{opacity}"></canvas>

<style>
  .bg-vis {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    z-index: 0;
    pointer-events: none;
    transition: opacity 0.2s linear;
  }
</style>
