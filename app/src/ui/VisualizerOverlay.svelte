<script lang="ts">
  import { onMount } from 'svelte';
  import { appState } from '../state';

  // Big visualizer view (PRD §8.5): resizable window over the app with a
  // fullscreen button. Renders the same scenes as the tile, larger, on a 2D
  // canvas at requestAnimationFrame rate.

  let open = $state(false);
  let moduleId: string | null = null;
  let canvasEl = $state<HTMLCanvasElement>();
  let containerEl = $state<HTMLDivElement>();
  let raf = 0;
  let particles: Array<{ x: number; y: number; vx: number; vy: number; life: number; hue: number }> = [];

  onMount(() =>
    appState.on('visualizerChanged', () => {
      moduleId = appState.visualizerOpen;
      open = moduleId !== null;
      particles = [];
      cancelAnimationFrame(raf);
      if (open) raf = requestAnimationFrame(draw);
    }),
  );

  function close() {
    appState.closeVisualizer();
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
    const ctx = canvasEl.getContext('2d')!;
    const W = (canvasEl.width = canvasEl.clientWidth);
    const H = (canvasEl.height = canvasEl.clientHeight);
    ctx.fillStyle = '#0c0c12';
    ctx.fillRect(0, 0, W, H);

    const mod = appState.graph.modules.get(moduleId);
    const data = appState.visData[moduleId];
    if (!mod || !data) return;
    const scene = Math.round(mod.params.scene ?? 0);
    const ctrl = data.ctrl >= 0 ? data.ctrl : 1;
    const gain = (mod.params.gain ?? 1.5) * (0.3 + 0.7 * ctrl);

    if (scene === 0) {
      ctx.strokeStyle = '#3dd9ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      data.wave.forEach((v, i) => {
        const x = (i / (data.wave.length - 1)) * W;
        const y = H / 2 - Math.max(-1, Math.min(1, v * gain)) * (H / 2 - 10);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    } else if (scene === 1) {
      const n = data.spectrum.length;
      const bw = W / n;
      for (let b = 0; b < n; b++) {
        const frac = Math.min(1, Math.max(0, (data.spectrum[b] + 80) / 80)) * Math.min(1, gain);
        if (frac <= 0.01) continue;
        ctx.fillStyle = `hsl(${35 + frac * 20} 90% ${45 + frac * 20}%)`;
        ctx.fillRect(b * bw + 1, H - frac * (H - 10), bw - 2, frac * (H - 10));
      }
    } else {
      let energy = 0;
      for (const db of data.spectrum) energy = Math.max(energy, (db + 80) / 80);
      for (const pitch of data.notes) {
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
  <div class="vis-overlay" bind:this={containerEl}>
    <div class="vis-bar">
      <span class="vis-title">Visualizer</span>
      <span class="spacer"></span>
      <button onclick={fullscreen} title="Toggle fullscreen">⛶</button>
      <button onclick={close} title="Close (Esc)">✕</button>
    </div>
    <canvas bind:this={canvasEl}></canvas>
  </div>
{/if}

<style>
  .vis-overlay {
    position: fixed;
    inset: 8vh 10vw;
    background: #0c0c12;
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    z-index: 70;
    overflow: hidden;
  }
  .vis-overlay:fullscreen {
    inset: 0;
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
