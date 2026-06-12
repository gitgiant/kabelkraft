<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { patchCanvas } from '../canvas/PatchCanvas';
  import { appState } from '../state';
  import { binFrac } from '../visual/features';
  import { approximateScene, visGraphOf } from '../visual/migrate';
  import { ContainerRenderer, graphSupported, webgpuAvailable } from '../visual/runtime';
  import type { VisGraphData } from '../visual/types';

  // Big visualizer view — opens IN PLACE: the tile grows and this panel pins
  // itself over the module, tracking canvas pan/zoom (no full-screen
  // takeover). ⛶ still offers real fullscreen for performance; ⧉ pops out a
  // window for a projector. WebGPU runtime renders supported graphs;
  // browsers without WebGPU get the Canvas2D approximation tier.

  let open = $state(false);
  let gpuMode = $state(false);
  let moduleId: string | null = null;
  let graph: VisGraphData | null = null;
  let canvasEl = $state<HTMLCanvasElement>();
  let containerEl = $state<HTMLDivElement>();
  let raf = 0;
  let renderer: ContainerRenderer | null = null;
  let particles: Array<{ x: number; y: number; vx: number; vy: number; life: number; hue: number }> = [];

  // Panel anchoring over the module tile (PianoRoll pattern).
  const INSET_X = 14;
  const INSET_T = 28;
  const INSET_B = 14;
  let panelLeft = $state(0);
  let panelTop = $state(0);
  let panelW = $state(800);
  let panelH = $state(520);
  let scale = $state(1);
  let onScreen = $state(true);

  function reposition(): void {
    if (!moduleId || document.fullscreenElement === containerEl) return;
    const r = patchCanvas.clientRectFor(moduleId);
    if (!r || !r.onScreen) {
      onScreen = false;
      return;
    }
    onScreen = true;
    scale = r.scale;
    panelW = r.width / r.scale - INSET_X * 2;
    panelH = r.height / r.scale - INSET_T - INSET_B;
    panelLeft = r.left + INSET_X * r.scale;
    panelTop = r.top + INSET_T * r.scale;
  }

  onMount(() => {
    const offV = appState.on('visualizerChanged', () => {
      moduleId = appState.visualizerOpen;
      const mod = moduleId ? appState.graph.modules.get(moduleId) : null;
      graph = mod ? visGraphOf(mod.data) : null;
      open = moduleId !== null;
      particles = [];
      renderer = null;
      cancelAnimationFrame(raf);
      // GPU vs 2D is decided per open: a canvas can hold only one context type.
      gpuMode = open && webgpuAvailable() && graphSupported(graph);
      if (open) {
        reposition();
        if (gpuMode) void attachRenderer(moduleId!);
        raf = requestAnimationFrame(draw);
      }
    });
    // Module deleted while open → close.
    const offG = appState.on('graphChanged', () => {
      if (open && moduleId && !appState.graph.modules.has(moduleId)) appState.closeVisualizer();
    });
    return () => {
      offV();
      offG();
      cancelAnimationFrame(raf);
    };
  });

  async function attachRenderer(forModule: string): Promise<void> {
    // canvasEl mounts on the next tick once `open` flips.
    await tick();
    if (!open || moduleId !== forModule || !canvasEl) return;
    const r = await ContainerRenderer.create(canvasEl);
    if (!open || moduleId !== forModule) return;
    if (r) renderer = r;
    else gpuMode = false; // device refused — re-mount the canvas for 2D
  }

  function close() {
    appState.closeVisualizer();
  }

  // -- pop-out window (projector / second monitor) -----------------------------
  // Independent of the panel: keeps rendering after it closes, driven by the
  // pop-out's own rAF so it runs at that display's refresh rate.

  let popup: { win: Window; renderer: ContainerRenderer | null; moduleId: string } | null = null;

  async function popOut(): Promise<void> {
    if (!moduleId) return;
    popup?.win.close();
    const win = window.open('', 'kk-vis-popout', 'width=960,height=540');
    if (!win) return;
    win.document.title = 'KabelKraft Visualizer';
    win.document.body.style.cssText = 'margin:0;background:#0c0c12;overflow:hidden';
    const canvas = win.document.createElement('canvas');
    canvas.style.cssText = 'width:100vw;height:100vh;display:block';
    win.document.body.appendChild(canvas);
    const entry = { win, renderer: null as ContainerRenderer | null, moduleId };
    popup = entry;
    entry.renderer = await ContainerRenderer.create(canvas);
    if (popup !== entry) return;
    if (!entry.renderer) {
      win.document.body.innerHTML =
        '<p style="color:#888;font:13px sans-serif;padding:20px">WebGPU unavailable in this window.</p>';
    }
    popupLoop();
  }

  function popupLoop(): void {
    if (!popup || popup.win.closed) {
      popup?.renderer?.destroy();
      popup = null;
      return;
    }
    popup.win.requestAnimationFrame(popupLoop);
    const mod = appState.graph.modules.get(popup.moduleId);
    const g = mod ? visGraphOf(mod.data) : null;
    if (popup.renderer && g && graphSupported(g)) {
      popup.renderer.render(g, appState.visFeatures(popup.moduleId));
    }
  }

  async function fullscreen() {
    if (!containerEl) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await containerEl.requestFullscreen();
  }

  function onKey(e: KeyboardEvent) {
    if (open && e.key === 'Escape' && !document.fullscreenElement) close();
  }

  function draw() {
    if (!open || !canvasEl || !moduleId) return;
    raf = requestAnimationFrame(draw);
    reposition();
    const features = appState.visFeatures(moduleId);
    // Re-read per frame — the visual editor mutates the graph live.
    const mod = appState.graph.modules.get(moduleId);
    graph = mod ? visGraphOf(mod.data) : null;
    const fullscreenNow = document.fullscreenElement === containerEl;
    const res = fullscreenNow ? 1 : scale;

    if (gpuMode) {
      if (renderer && graph && graphSupported(graph)) {
        renderer.resolutionScale = res;
        renderer.render(graph, features);
      }
      return;
    }

    // Null while the {#key} block swaps in a fresh canvas after a GPU→2D flip
    // (a canvas that ever held a webgpu context refuses a 2d one).
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    const W = (canvasEl.width = Math.round(canvasEl.clientWidth * res));
    const H = (canvasEl.height = Math.round(canvasEl.clientHeight * res));
    ctx.fillStyle = '#0c0c12';
    ctx.fillRect(0, 0, W, H);
    if (!features) return;

    const { scene, gain: baseGain } = approximateScene(graph);
    const ctrl = features.ctrl >= 0 ? features.ctrl : 1;
    const gain = baseGain * (0.3 + 0.7 * ctrl);

    if (scene === 'scope') {
      ctx.strokeStyle = '#3dd9ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const n = features.wave.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        const y = H / 2 - Math.max(-1, Math.min(1, features.wave[i] * gain)) * (H / 2 - 10);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (scene === 'spectrum') {
      const n = features.spectrum.length;
      const bw = W / n;
      for (let b = 0; b < n; b++) {
        const frac = binFrac(features.spectrum[b]) * Math.min(1, gain);
        if (frac <= 0.01) continue;
        ctx.fillStyle = `hsl(${35 + frac * 20} 90% ${45 + frac * 20}%)`;
        ctx.fillRect(b * bw + 1, H - frac * (H - 10), bw - 2, frac * (H - 10));
      }
    } else {
      let energy = 0;
      for (const db of features.spectrum) energy = Math.max(energy, binFrac(db));
      for (const pitch of features.notes) {
        const hue = ((pitch % 12) / 12) * 360;
        for (let i = 0; i < 12; i++) {
          particles.push({
            x: W * ((pitch % 36) / 36),
            y: H * 0.7,
            vx: (Math.random() - 0.5) * 6,
            vy: -2 - Math.random() * 5,
            life: 1,
            hue,
          });
        }
      }
      if (particles.length > 600) particles.splice(0, particles.length - 600);
      const speed = 0.5 + energy * 2 * gain;
      particles = particles.filter((p) => {
        p.x += p.vx * speed;
        p.y += p.vy * speed;
        p.vy += 0.06;
        p.life -= 0.012;
        if (p.life <= 0 || p.x < 0 || p.x > W || p.y > H) return false;
        ctx.fillStyle = `hsl(${p.hue} 80% 60% / ${p.life})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2 + p.life * 5, 0, Math.PI * 2);
        ctx.fill();
        return true;
      });
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div
    class="vis-overlay"
    bind:this={containerEl}
    style="left:{panelLeft}px;top:{panelTop}px;width:{panelW}px;height:{panelH}px;transform:scale({scale});visibility:{onScreen ? 'visible' : 'hidden'}"
  >
    <div class="vis-bar">
      <span class="vis-title">Visualizer</span>
      <span class="spacer"></span>
      <button onclick={popOut} title="Pop out to a separate window (projector)">⧉</button>
      <button onclick={fullscreen} title="Toggle fullscreen">⛶</button>
      <button onclick={close} title="Close (Esc)">✕</button>
    </div>
    {#key gpuMode}
      <canvas bind:this={canvasEl}></canvas>
    {/key}
  </div>
{/if}

<style>
  .vis-overlay {
    position: fixed;
    transform-origin: 0 0;
    background: #0c0c12;
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    z-index: 60;
    overflow: hidden;
  }
  .vis-overlay:fullscreen {
    inset: 0;
    width: 100vw;
    height: 100vh;
    transform: none;
    border-radius: 0;
  }
  .vis-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--panel);
  }
  .vis-title {
    font-weight: 700;
    font-size: 13px;
    color: var(--text);
  }
  .spacer {
    flex: 1;
  }
  canvas {
    flex: 1;
    width: 100%;
    min-height: 0;
  }
</style>
