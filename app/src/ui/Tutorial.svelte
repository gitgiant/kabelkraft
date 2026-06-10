<script lang="ts">
  import { onMount } from 'svelte';
  import { appState } from '../state';
  import { DEFAULT_TRANSPORT } from '../core/types';

  interface Step {
    title: string;
    body: string;
    /** Auto-advance when this returns true. */
    check: () => boolean;
  }

  function hasModule(type: string): boolean {
    return [...appState.graph.modules.values()].some((m) => m.type === type);
  }

  function hasWire(fromType: string, toType: string, toPortId?: string): boolean {
    const mods = appState.graph.modules;
    return [...appState.graph.wires.values()].some((w) => {
      const from = mods.get(w.from.moduleId);
      const to = mods.get(w.to.moduleId);
      return (
        from?.type === fromType &&
        to?.type === toType &&
        (toPortId === undefined || w.to.portId === toPortId)
      );
    });
  }

  const steps: Step[] = [
    {
      title: 'Add a Synth',
      body: 'Open the module menu on the left and click "Synth" (under Generator) to place it on the canvas.',
      check: () => hasModule('synth'),
    },
    {
      title: 'Add a Keyboard',
      body: 'Now add a "Keyboard" from the Controller category — an on-screen piano you can play.',
      check: () => hasModule('keyboard'),
    },
    {
      title: 'Wire some notes',
      body: 'Drag from the Keyboard’s cyan Notes output (right edge) to the Synth’s cyan Notes input (left edge). Cyan ports carry note data. Release on the port — it snaps.',
      check: () => hasWire('keyboard', 'synth', 'notes'),
    },
    {
      title: 'Wire the audio',
      body: 'Drag from the Synth’s amber Audio output to the Audio Out module’s amber input. Amber ports carry sound itself.',
      check: () => hasWire('synth', 'audioOut', 'in'),
    },
    {
      title: 'Play!',
      body: 'Click the piano keys, or use your computer keyboard (A S D F G H J K = white keys). Watch the amber wire pulse with the sound level — and the cyan wire flash with each note. That’s the difference: audio wires carry sound, data wires carry events and control.',
      check: () => {
        const out = [...appState.graph.modules.values()].find((m) => m.type === 'audioOut');
        return out ? (appState.meters[out.id]?.peak ?? 0) > 0.02 : false;
      },
    },
    {
      title: 'Modulate with data',
      body: 'Add an LFO (Data category) and wire its magenta Control output to the Synth’s Pitch Mod input. Magenta wires glow with their value. Play a note — vibrato!',
      check: () => hasWire('lfo', 'synth', 'pitchMod'),
    },
  ];

  let active = $state(false);
  let stepIdx = $state(0);
  let done = $state(false);

  function start() {
    // Fresh minimal patch: transport + audio out, the rest is the lesson.
    appState.loadProject(
      JSON.stringify({
        formatVersion: 1,
        name: 'Tutorial',
        transport: DEFAULT_TRANSPORT,
        modules: [],
        wires: [],
      }),
    );
    appState.addModule('transport', -100, -280);
    appState.addModule('audioOut', 320, -40);
    void appState.ensureEngine();
    stepIdx = 0;
    done = false;
    active = true;
  }

  function skip() {
    active = false;
  }

  onMount(() => {
    const onStart = () => start();
    window.addEventListener('kk-start-tutorial', onStart);
    const poll = setInterval(() => {
      if (!active || done) return;
      if (steps[stepIdx].check()) {
        if (stepIdx === steps.length - 1) done = true;
        else stepIdx += 1;
      }
    }, 300);
    return () => {
      window.removeEventListener('kk-start-tutorial', onStart);
      clearInterval(poll);
    };
  });
</script>

{#if active}
  <div class="tutorial">
    {#if !done}
      <div class="tutorial-head">
        <span class="tutorial-step">Step {stepIdx + 1} / {steps.length}</span>
        <button class="tutorial-skip" onclick={skip}>Skip ✕</button>
      </div>
      <div class="tutorial-title">{steps[stepIdx].title}</div>
      <div class="tutorial-body">{steps[stepIdx].body}</div>
      <div class="tutorial-dots">
        {#each steps as _, i}
          <span class="dot" class:done={i < stepIdx} class:current={i === stepIdx}></span>
        {/each}
      </div>
    {:else}
      <div class="tutorial-head">
        <span class="tutorial-step">Tutorial complete 🎉</span>
        <button class="tutorial-skip" onclick={skip}>Close ✕</button>
      </div>
      <div class="tutorial-body">
        You wired notes (data) into sound (audio) and modulated it. Next things to try:
        insert a Reverb between Synth and Audio Out; shift-click Synth + LFO and press
        Cmd/Ctrl+G to group them; save your project from the toolbar.
      </div>
    {/if}
  </div>
{/if}

<style>
  .tutorial {
    position: absolute;
    top: 56px;
    right: 16px;
    width: 300px;
    z-index: 20;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 12px 14px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  }
  .tutorial-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }
  .tutorial-step {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--accent);
    font-weight: 700;
  }
  .tutorial-skip {
    font-size: 11px;
    padding: 2px 8px;
  }
  .tutorial-title {
    font-weight: 700;
    margin-bottom: 4px;
  }
  .tutorial-body {
    font-size: 13px;
    color: var(--text-dim);
    line-height: 1.45;
  }
  .tutorial-dots {
    display: flex;
    gap: 5px;
    margin-top: 10px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--control-border);
  }
  .dot.done {
    background: var(--accent);
    opacity: 0.5;
  }
  .dot.current {
    background: var(--accent);
  }
</style>
