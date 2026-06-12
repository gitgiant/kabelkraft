<script lang="ts">
  // Options dialog (OPTIONS_MENU_PLAN.md) — the single home for every
  // setting. Global tabs persist to the unified store (core/settings);
  // the Project tab edits per-project state saved in the .kkproj.
  import { onMount } from 'svelte';
  import { appState } from '../state';
  import { appSettings, updateSettings, UI_SCALES, type AppSettings } from '../core/settings';
  import { autosaveSize, clearAutosave } from '../core/autosave';
  import { loadSettings, type AiSettings } from '../core/aiprovider';
  import { setTheme } from '../theme';
  import { Engine } from '../engine/engine';
  import { audioPermissionGranted, ensureAudioPermission, listAudioDevices, onDeviceChange } from '../engine/devices';
  import { VIS_RATES, VIS_RES_SCALES } from '../visual/display';
  import type { StateEvent } from '../state';
  import AiSettingsPanel from './AiSettingsPanel.svelte';
  import { downloadProject } from './project-io';

  type Tab =
    | 'project' | 'audio' | 'midi' | 'display' | 'ai' | 'general' | 'shortcuts' | 'storage' | 'debug';

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'project', label: 'Project' },
    { id: 'audio', label: 'Audio' },
    { id: 'midi', label: 'MIDI' },
    { id: 'display', label: 'Display' },
    { id: 'ai', label: 'AI' },
    { id: 'general', label: 'General' },
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'storage', label: 'Storage' },
    { id: 'debug', label: 'Debug' },
  ];

  let open = $state(false);
  let tab = $state<Tab>('project');

  // Global settings snapshot the controls bind to; every change writes through
  // to the store (App.svelte listens and applies chrome-level effects).
  let cfg = $state<AppSettings>(structuredClone(appSettings()));
  let aiSettings = $state<AiSettings>(loadSettings());

  // Per-project fields (re-read on open / project load).
  let projectName = $state('');
  let artists = $state('');
  let description = $state('');
  let picture = $state('');
  let tempo = $state(120);
  let tsNum = $state(4);
  let tsDenom = $state(4);

  function readProject(): void {
    projectName = appState.projectName;
    artists = appState.projectMeta.artists ?? '';
    description = appState.projectMeta.description ?? '';
    picture = appState.projectMeta.picture ?? '';
    tempo = Math.round(appState.transport.tempo);
    tsNum = appState.transport.timeSignature.num;
    tsDenom = appState.transport.timeSignature.denom;
  }

  export function show(which: Tab = 'project'): void {
    cfg = structuredClone(appSettings());
    aiSettings = loadSettings();
    readProject();
    tab = which;
    open = true;
  }

  function onOpenEvent(e: Event): void {
    show(((e as CustomEvent).detail?.tab as Tab) ?? 'project');
  }

  function onKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      if (open) open = false;
      else show();
    } else if (open && e.key === 'Escape') {
      open = false;
    }
  }

  function save(fn: (s: AppSettings) => void): void {
    updateSettings(fn);
    cfg = structuredClone(appSettings());
  }

  // -- Audio ------------------------------------------------------------------

  const sinkSelectable = Engine.sinkSelectable;
  let outputs = $state<Array<{ deviceId: string; label: string }>>([]);
  let inputs = $state<Array<{ deviceId: string; label: string }>>([]);
  let deviceAccess = $state(audioPermissionGranted());
  let accessDenied = $state(false);
  let inputErrors = $state<Array<{ device: string; error: string }>>([]);
  /** Open capture streams with the channel count the browser delivered. */
  let captureInfo = $state<Array<{ label: string; channels: number }>>([]);
  let outputChannels = $state(2);
  let engineUp = $state(false);

  /** Cheap engine read-outs (no enumerate) — safe to poll while the tab shows. */
  function refreshChannelInfo(): void {
    engineUp = appState.engine.started;
    outputChannels = appState.engine.outputChannels;
    captureInfo = appState.engine.inputChannelInfo().map((s) => ({
      label:
        inputs.find((d) => d.deviceId === s.deviceId)?.label ||
        (s.deviceId ? s.deviceId : 'default input'),
      channels: s.channels,
    }));
    inputErrors = [...appState.engine.inputErrors.entries()].map(([device, error]) => ({
      device: inputs.find((d) => d.deviceId === device)?.label || device || 'default input',
      error,
    }));
  }

  async function refreshDevices(): Promise<void> {
    const lists = await listAudioDevices();
    inputs = lists.inputs;
    outputs = lists.outputs;
    deviceAccess = audioPermissionGranted();
    refreshChannelInfo();
  }

  /** Ask for capture permission so the full device list (with labels) appears. */
  async function requestDeviceAccess(): Promise<void> {
    accessDenied = !(await ensureAudioPermission());
    await refreshDevices();
  }

  function applyInputDevice(): void {
    save((s) => { s.audio.inputId = cfg.audio.inputId; });
    appState.engine.defaultInputId = cfg.audio.inputId;
    appState.engine.inputErrors.clear();
    appState.engine.syncInputs(appState.graph);
  }

  /** Construction-time options changed — rebuild the context (brief dropout). */
  function applyAudioRestart(): void {
    if (appState.engine.started) void appState.restartEngine();
  }

  function applyMasterGain(): void {
    appState.engine.setMasterGain(cfg.audio.muted ? 0 : cfg.audio.masterGain);
  }

  const latency = $derived.by(() => {
    void open;
    return appState.engine.latencyInfo();
  });

  // -- MIDI ---------------------------------------------------------------------

  let midiInputs = $state<Array<{ id: string; name: string; active: boolean; enabled: boolean }>>([]);
  let midiOutputs = $state<Array<{ id: string; name: string }>>([]);
  let mappings = $state<Array<{ key: string; label: string }>>([]);
  let midiSupported = $state(true);
  let midiReady = $state(false);
  /** MIDI In/Out modules in the patch, for per-module device routing. */
  let midiModules = $state<Array<{ id: string; type: string; label: string; deviceId: string }>>([]);

  function refreshMidi(): void {
    midiSupported = appState.midi.supported;
    midiReady = appState.midi.ready;
    midiModules = [...appState.graph.modules.values()]
      .filter((m) => m.type === 'midiIn' || m.type === 'midiOut')
      .map((m) => ({
        id: m.id,
        type: m.type,
        label: m.label || (m.type === 'midiIn' ? 'MIDI In' : 'MIDI Out'),
        deviceId: (m.data?.deviceId as string) || '',
      }));
    const now = Date.now();
    midiInputs = appState.midi.inputs().map((d) => ({
      id: d.id,
      name: d.name,
      active: now - (appState.midi.lastActivity.get(d.id) ?? 0) < 400,
      enabled: !appState.midi.disabledInputs.has(d.id),
    }));
    midiOutputs = appState.midi.outputs();
    mappings = [...appState.midiMap.entries()].map(([key, t]) => {
      const mod = appState.graph.modules.get(t.moduleId);
      const [ch, cc] = key.split(':');
      return {
        key,
        label: `ch ${ch} · CC ${cc} → ${mod?.type ?? 'missing'} (${t.moduleId}) · ${t.paramId}`,
      };
    });
  }

  /** Route a MIDI In/Out module to one device ('' = all inputs / first output). */
  function setModuleDevice(moduleId: string, type: string, deviceId: string): void {
    const devices = type === 'midiIn' ? appState.midi.inputs() : appState.midi.outputs();
    const name =
      devices.find((d) => d.id === deviceId)?.name ??
      (type === 'midiIn' ? 'all inputs' : 'first output');
    appState.setModuleData(moduleId, 'deviceId', deviceId);
    appState.setModuleData(moduleId, 'deviceName', name);
    refreshMidi();
  }

  function connectMidi(): void {
    void appState.midi.init().then(refreshMidi);
  }

  function setInputEnabled(id: string, enabled: boolean): void {
    save((s) => {
      const set = new Set(s.midi.disabledInputs);
      if (enabled) set.delete(id);
      else set.add(id);
      s.midi.disabledInputs = [...set];
    });
    appState.midi.disabledInputs = new Set(cfg.midi.disabledInputs);
    refreshMidi();
  }

  // -- Project ------------------------------------------------------------------

  async function pickPicture(e: Event): Promise<void> {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    picture = c.toDataURL('image/jpeg', 0.85);
    appState.setProjectMeta({ picture });
    (e.target as HTMLInputElement).value = '';
  }

  // -- General / tutorial ---------------------------------------------------------

  // Tutorial rearranges the patch — offer to save first (moved from Toolbar).
  let tutorialPrompt = $state(false);

  function launchTutorial(saveFirst: boolean): void {
    if (saveFirst) downloadProject();
    tutorialPrompt = false;
    open = false;
    window.dispatchEvent(new CustomEvent('kk-start-tutorial'));
  }

  // -- Storage ---------------------------------------------------------------------

  let storageUsed = $state<number | null>(null);
  let storageQuota = $state<number | null>(null);
  let autosaveBytes = $state<number | null>(null);

  async function refreshStorage(): Promise<void> {
    autosaveBytes = await autosaveSize();
    try {
      const est = await navigator.storage?.estimate?.();
      storageUsed = est?.usage ?? null;
      storageQuota = est?.quota ?? null;
    } catch {
      storageUsed = storageQuota = null;
    }
  }

  function fmtBytes(n: number | null): string {
    if (n === null) return '–';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  // -- Debug --------------------------------------------------------------------------

  let uiFps = $state(0);
  let perf = $state({ load: 0, underruns: 0 });
  let counts = $state({ modules: 0, wires: 0, groups: 0 });
  let monitor = $state<Array<{ t: number; deviceId: string; data: string }>>([]);
  let copied = $state(false);
  let tracing = $state(false);
  let traceOffs: Array<() => void> = [];

  const TRACE_EVENTS: StateEvent[] = [
    'graphChanged', 'paramChanged', 'transportChanged', 'selectionChanged',
    'projectLoaded', 'sampleLoaded', 'midiChanged', 'composerChanged',
  ];

  function setTracing(on: boolean): void {
    tracing = on;
    for (const off of traceOffs) off();
    traceOffs = [];
    if (on) {
      traceOffs = TRACE_EVENTS.map((ev) =>
        appState.on(ev, () => console.log(`[kk trace] ${ev}`)),
      );
    }
  }

  function refreshDebug(): void {
    perf = { ...appState.enginePerf };
    counts = {
      modules: appState.graph.modules.size,
      wires: appState.graph.wires.size,
      groups: appState.graph.groups.size,
    };
    monitor = appState.midi.recvLog.slice(-12).reverse().map((m) => ({
      t: m.t,
      deviceId: m.deviceId,
      data: m.data.map((b) => b.toString(16).padStart(2, '0')).join(' '),
    }));
  }

  async function copyDiagnostics(): Promise<void> {
    const lat = appState.engine.latencyInfo();
    const diag = {
      when: new Date().toISOString(),
      userAgent: navigator.userAgent,
      engine: {
        state: appState.engine.contextState,
        sampleRate: appState.engine.sampleRate,
        baseLatency: lat?.base ?? null,
        outputLatency: lat?.output ?? null,
        perf: appState.enginePerf,
      },
      graph: counts,
      transport: appState.transport,
      settings: { ...appSettings(), ai: { provider: appSettings().ai.provider } }, // no keys
      midi: { inputs: appState.midi.inputs(), outputs: appState.midi.outputs() },
    };
    await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  // -- Lifecycle: pollers only run while the dialog is open ------------------------

  onMount(() => {
    window.addEventListener('kk-options', onOpenEvent);
    window.addEventListener('keydown', onKey);
    const offLoad = appState.on('projectLoaded', () => {
      if (open) readProject();
    });

    let frames = 0;
    let raf = 0;
    let lastFpsAt = performance.now();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      frames++;
      const now = performance.now();
      if (now - lastFpsAt >= 500) {
        uiFps = Math.round((frames * 1000) / (now - lastFpsAt));
        frames = 0;
        lastFpsAt = now;
      }
    };

    const poll = setInterval(() => {
      if (!open) return;
      if (tab === 'midi') refreshMidi();
      if (tab === 'audio') refreshChannelInfo();
      if (tab === 'debug') refreshDebug();
    }, 400);

    // Hot-plugging an interface refreshes the Audio tab's device lists live.
    const offDevices = onDeviceChange(() => {
      if (open && tab === 'audio') void refreshDevices();
    });

    // FPS loop only while the Debug tab is showing.
    const watch = setInterval(() => {
      const want = open && tab === 'debug';
      if (want && raf === 0) {
        frames = 0;
        lastFpsAt = performance.now();
        raf = requestAnimationFrame(tick);
      } else if (!want && raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }, 250);

    return () => {
      window.removeEventListener('kk-options', onOpenEvent);
      window.removeEventListener('keydown', onKey);
      offLoad();
      offDevices();
      clearInterval(poll);
      clearInterval(watch);
      if (raf) cancelAnimationFrame(raf);
      setTracing(false);
    };
  });

  function onTab(t: Tab): void {
    tab = t;
    if (t === 'midi') {
      void appState.midi.init().then(refreshMidi);
      refreshMidi();
    }
    if (t === 'audio') void refreshDevices();
    if (t === 'storage') void refreshStorage();
    if (t === 'debug') refreshDebug();
  }
</script>

{#if open}
  <div class="options-backdrop">
    <div class="options-dialog" role="dialog" aria-label="Options">
      <div class="options-header">
        <span class="options-title">⚙ Options</span>
        <span class="spacer"></span>
        <button class="close-options" onclick={() => (open = false)} title="Close (Esc)">✕</button>
      </div>

      <div class="options-body">
        <nav class="options-tabs">
          {#each TABS as t (t.id)}
            <button class="tab" class:active={tab === t.id} data-tab={t.id} onclick={() => onTab(t.id)}>
              {t.label}
            </button>
          {/each}
        </nav>

        <div class="tab-pane">
          {#if tab === 'project'}
            <p class="pane-note badge">📁 Saved with the project (.kkproj)</p>
            <label class="row">
              <span>Name</span>
              <input class="grow opt-project-name" bind:value={projectName}
                onchange={() => appState.setProjectName(projectName)} />
            </label>
            <label class="row">
              <span>Tempo</span>
              <input class="opt-bpm" type="number" min="20" max="300" bind:value={tempo}
                onchange={() => appState.setTempo(tempo)} /> BPM
            </label>
            <div class="row">
              <span>Time signature</span>
              <input class="opt-ts-num" type="number" min="1" max="32" bind:value={tsNum}
                onchange={() => appState.setTimeSignature(tsNum, tsDenom)} />
              <span>/</span>
              <select class="opt-ts-denom" bind:value={tsDenom}
                onchange={() => appState.setTimeSignature(tsNum, tsDenom)}>
                {#each [1, 2, 4, 8, 16, 32] as d (d)}<option value={d}>{d}</option>{/each}
              </select>
              <span class="dim">display only — playback math is unaffected</span>
            </div>
            <label class="row">
              <span>Artists</span>
              <input class="grow opt-artists" bind:value={artists} placeholder="who made this"
                onchange={() => appState.setProjectMeta({ artists })} />
            </label>
            <label class="row top">
              <span>Description</span>
              <textarea class="grow opt-description" rows="3" bind:value={description}
                onchange={() => appState.setProjectMeta({ description })}></textarea>
            </label>
            <div class="row top">
              <span>Picture</span>
              <div class="pic-cell">
                {#if picture}
                  <img class="opt-picture" src={picture} alt="Project cover" />
                  <button onclick={() => { picture = ''; appState.setProjectMeta({ picture: '' }); }}>Remove</button>
                {:else}
                  <input type="file" accept="image/*" onchange={pickPicture} />
                  <span class="dim">downscaled to ≤512px, embedded in the .kkproj</span>
                {/if}
              </div>
            </div>

          {:else if tab === 'audio'}
            <p class="pane-note">Latency, sample rate and output device rebuild the audio engine when changed — expect a brief dropout.</p>
            <label class="row">
              <span>Master volume</span>
              <input class="opt-master-gain" type="range" min="0" max="1.5" step="0.01"
                bind:value={cfg.audio.masterGain}
                oninput={() => { save((s) => { s.audio.masterGain = cfg.audio.masterGain; }); applyMasterGain(); }} />
              <span class="dim">{Math.round(cfg.audio.masterGain * 100)}%</span>
              <label class="inline">
                <input class="opt-mute" type="checkbox" bind:checked={cfg.audio.muted}
                  onchange={() => { save((s) => { s.audio.muted = cfg.audio.muted; }); applyMasterGain(); }} />
                Mute
              </label>
            </label>
            <label class="row">
              <span>Latency</span>
              <select class="opt-latency" bind:value={cfg.audio.latencyHint}
                onchange={() => { save((s) => { s.audio.latencyHint = cfg.audio.latencyHint; }); applyAudioRestart(); }}>
                <option value="interactive">Interactive (lowest)</option>
                <option value="balanced">Balanced</option>
                <option value="playback">Playback (most stable)</option>
              </select>
              {#if latency}
                <span class="dim">measured: base {(latency.base * 1000).toFixed(1)} ms · output {(latency.output * 1000).toFixed(1)} ms</span>
              {/if}
            </label>
            <label class="row">
              <span>Sample rate</span>
              <select class="opt-sample-rate" bind:value={cfg.audio.sampleRate}
                onchange={() => { save((s) => { s.audio.sampleRate = cfg.audio.sampleRate; }); applyAudioRestart(); }}>
                <option value={0}>Browser default</option>
                <option value={44100}>44.1 kHz</option>
                <option value={48000}>48 kHz</option>
                <option value={88200}>88.2 kHz</option>
                <option value={96000}>96 kHz</option>
              </select>
            </label>
            {#if !deviceAccess}
              <div class="row">
                <button class="opt-device-access" onclick={() => void requestDeviceAccess()}>🎙 Allow device access</button>
                <span class="dim">
                  {accessDenied
                    ? 'Permission denied — allow microphone access in the browser\'s site settings, then retry.'
                    : 'Browsers hide audio interfaces and device names until a microphone permission is granted.'}
                </span>
              </div>
            {/if}
            {#if sinkSelectable}
              <label class="row">
                <span>Output device</span>
                <select class="opt-sink grow" bind:value={cfg.audio.sinkId}
                  onchange={() => { save((s) => { s.audio.sinkId = cfg.audio.sinkId; }); applyAudioRestart(); }}>
                  <option value="">System default</option>
                  {#each outputs as o (o.deviceId)}<option value={o.deviceId}>{o.label}</option>{/each}
                </select>
                {#if engineUp}
                  <span class="dim opt-out-channels">{outputChannels} ch</span>
                {/if}
              </label>
              {#if engineUp && outputChannels > 2}
                <p class="pane-note dim">Multichannel output active — Audio Out modules pick their hardware pair (1-2 / 3-4 / …) with the Pair knob.</p>
              {/if}
            {:else}
              <p class="pane-note dim">Output device selection isn't supported by this browser (Chrome/Edge only).</p>
            {/if}
            <label class="row">
              <span>Input device</span>
              <select class="opt-input grow" bind:value={cfg.audio.inputId} onchange={applyInputDevice}>
                <option value="">System default</option>
                {#each inputs as d (d.deviceId)}<option value={d.deviceId}>{d.label}</option>{/each}
              </select>
            </label>
            <p class="pane-note dim">Default capture device for Audio In modules; each module can also pick its own input on its device row. Lists refresh automatically when devices are plugged in.</p>
            {#each captureInfo as c (c.label)}
              <p class="pane-note dim opt-capture-info">🎙 {c.label}: capturing {c.channels} ch{c.channels > 2 ? ' — pick the pair on each Audio In module' : ''}</p>
            {/each}
            {#each inputErrors as e (e.device)}
              <p class="pane-note opt-input-error">⚠ {e.device}: capture failed — {e.error}</p>
            {/each}

          {:else if tab === 'midi'}
            {#if !midiSupported}
              <p class="pane-note">WebMIDI isn't available in this browser — Chrome/Edge support it; Firefox/Safari don't.</p>
            {:else}
              {#if !midiReady}
                <div class="row">
                  <button class="connect-midi" onclick={connectMidi}>🔌 Connect MIDI</button>
                  <span class="dim">asks the browser for MIDI access — allow the permission prompt</span>
                </div>
              {/if}
              <h3>Inputs</h3>
              {#if midiInputs.length === 0}
                <p class="pane-note dim">
                  {midiReady
                    ? 'MIDI access granted, but no input devices detected — check the connection; the list refreshes live.'
                    : 'No MIDI inputs yet — click Connect MIDI above.'}
                </p>
              {/if}
              {#each midiInputs as d (d.id)}
                <div class="row midi-device">
                  <span class="activity" class:blink={d.active} title="Lights up on incoming messages">●</span>
                  <span class="grow">{d.name}</span>
                  <label class="inline">
                    <input type="checkbox" checked={d.enabled}
                      onchange={(e) => setInputEnabled(d.id, e.currentTarget.checked)} />
                    Enabled
                  </label>
                </div>
              {/each}
              <h3>Outputs</h3>
              {#if midiOutputs.length === 0}
                <p class="pane-note dim">No MIDI outputs detected.</p>
              {/if}
              {#each midiOutputs as d (d.id)}
                <div class="row midi-device"><span class="grow">{d.name}</span></div>
              {/each}
              <h3>Module routing</h3>
              {#if midiModules.length === 0}
                <p class="pane-note dim">No MIDI In / MIDI Out modules in the patch. Add a MIDI In module and wire its notes into a Voice to play hardware.</p>
              {:else}
                {#each midiModules as m (m.id)}
                  <div class="row midi-route">
                    <span>{m.label}</span>
                    <select
                      value={m.deviceId}
                      onchange={(e) => setModuleDevice(m.id, m.type, e.currentTarget.value)}
                    >
                      <option value="">{m.type === 'midiIn' ? 'All inputs' : 'First output'}</option>
                      {#each m.type === 'midiIn' ? midiInputs : midiOutputs as d (d.id)}
                        <option value={d.id}>{d.name}</option>
                      {/each}
                    </select>
                    <span class="dim mono">{m.id}</span>
                  </div>
                {/each}
              {/if}
              <h3>Learned mappings</h3>
              {#if mappings.length === 0}
                <p class="pane-note dim">None yet — right-click a knob and choose MIDI learn, then move a controller.</p>
              {:else}
                {#each mappings as m (m.key)}
                  <div class="row mapping">
                    <span class="grow mono">{m.label}</span>
                    <button onclick={() => { appState.removeMidiMapping(m.key); refreshMidi(); }}>Delete</button>
                  </div>
                {/each}
                <div class="row">
                  <button class="clear-mappings" onclick={() => { appState.clearMidiMappings(); refreshMidi(); }}>
                    Clear all mappings
                  </button>
                </div>
              {/if}
            {/if}

          {:else if tab === 'display'}
            <label class="row">
              <span>Theme</span>
              <select class="opt-theme" bind:value={cfg.display.theme}
                onchange={() => { setTheme(cfg.display.theme); cfg = structuredClone(appSettings()); }}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>
            <label class="row">
              <span>UI scale</span>
              <select class="opt-ui-scale" bind:value={cfg.display.uiScale}
                onchange={() => save((s) => { s.display.uiScale = cfg.display.uiScale; })}>
                {#each UI_SCALES as u (u)}<option value={u}>{Math.round(u * 100)}%</option>{/each}
              </select>
            </label>
            <label class="row">
              <span>Visualizer FPS cap</span>
              <select class="opt-vis-fps" bind:value={cfg.display.visMaxFps}
                onchange={() => save((s) => { s.display.visMaxFps = cfg.display.visMaxFps; })}>
                {#each VIS_RATES as r (r)}
                  <option value={r}>{r === 240 ? '240 (uncapped)' : `${r} fps`}</option>
                {/each}
              </select>
              <span class="dim">machine-wide ceiling over each visualizer's own setting</span>
            </label>
            <label class="row">
              <span>Visualizer resolution cap</span>
              <select class="opt-vis-res" bind:value={cfg.display.visMaxRes}
                onchange={() => save((s) => { s.display.visMaxRes = cfg.display.visMaxRes; })}>
                {#each VIS_RES_SCALES as r (r)}<option value={r}>{Math.round(r * 100)}%</option>{/each}
              </select>
            </label>

          {:else if tab === 'ai'}
            <AiSettingsPanel bind:settings={aiSettings} />
            <p class="pane-note dim">Used by AI Patch, AI Project, group AI edit and the piano roll's AI MIDI.</p>

          {:else if tab === 'general'}
            <label class="row">
              <span>Default tempo</span>
              <input class="opt-default-tempo" type="number" min="20" max="300"
                bind:value={cfg.general.defaultTempo}
                onchange={() => save((s) => { s.general.defaultTempo = cfg.general.defaultTempo; })} />
              <span class="dim">BPM a fresh session starts with</span>
            </label>
            <label class="row">
              <input class="opt-qwerty" type="checkbox" bind:checked={cfg.general.qwertyPiano}
                onchange={() => save((s) => { s.general.qwertyPiano = cfg.general.qwertyPiano; })} />
              <span>Play notes with the computer keyboard</span>
              <span class="dim">A-row = piano (A W S E D …), relative to each keyboard module's octave</span>
            </label>
            <label class="row">
              <input class="opt-confirm-leave" type="checkbox" bind:checked={cfg.general.confirmLeave}
                onchange={() => save((s) => { s.general.confirmLeave = cfg.general.confirmLeave; })} />
              <span>Confirm before leaving the page</span>
            </label>
            <label class="row">
              <input class="opt-autosave" type="checkbox" bind:checked={cfg.general.autosave}
                onchange={() => save((s) => { s.general.autosave = cfg.general.autosave; })} />
              <span>Autosave session</span>
              <input class="opt-autosave-interval" type="number" min="5" max="600"
                bind:value={cfg.general.autosaveInterval} disabled={!cfg.general.autosave}
                onchange={() => save((s) => { s.general.autosaveInterval = cfg.general.autosaveInterval; })} />
              <span class="dim">seconds — full project incl. samples, restored after a crash</span>
            </label>
            <div class="row">
              <button class="restart-tutorial" onclick={() => (tutorialPrompt = true)}>Restart tutorial</button>
            </div>

          {:else if tab === 'shortcuts'}
            <table class="shortcuts">
              <tbody>
                <tr><td class="mono">Cmd/Ctrl + Z</td><td>Undo</td></tr>
                <tr><td class="mono">Cmd/Ctrl + Shift + Z</td><td>Redo</td></tr>
                <tr><td class="mono">Cmd/Ctrl + G</td><td>Group selection</td></tr>
                <tr><td class="mono">Cmd/Ctrl + Shift + G</td><td>Ungroup</td></tr>
                <tr><td class="mono">Cmd/Ctrl + ,</td><td>Open / close Options</td></tr>
                <tr><td class="mono">Esc</td><td>Close dialog · cancel MIDI learn</td></tr>
                <tr><td class="mono">Shift + click / drag</td><td>Multi-select modules</td></tr>
                <tr><td class="mono">A W S E D F T G Y H U J K O L</td><td>QWERTY piano (relative to each keyboard's octave)</td></tr>
                <tr><td class="mono">Double-press Stop</td><td>Panic — kill voices &amp; feedback loops</td></tr>
              </tbody>
            </table>

          {:else if tab === 'storage'}
            <div class="row"><span>Browser storage used</span><span class="mono">{fmtBytes(storageUsed)} of {fmtBytes(storageQuota)}</span></div>
            <div class="row"><span>Autosave record</span><span class="mono opt-autosave-size">{fmtBytes(autosaveBytes)}</span>
              <button class="clear-autosave" onclick={() => { void clearAutosave().then(refreshStorage); }}>Clear</button>
            </div>
            <p class="pane-note dim">Samples you browse in the Sample Library stay in your own folders — only project saves and the autosave record live in the browser.</p>

          {:else if tab === 'debug'}
            <div class="debug-grid">
              <div class="row"><span>UI</span><span class="mono opt-fps">{uiFps} fps</span></div>
              <div class="row"><span>DSP load</span><span class="mono">{Math.round(perf.load * 100)}%</span></div>
              <div class="row"><span>Underruns</span><span class="mono opt-underruns">{perf.underruns}</span><span class="dim">approximate — counted when the audio clock falls behind wall time</span></div>
              <div class="row"><span>Engine</span><span class="mono">{appState.engine.contextState} · {appState.engine.sampleRate} Hz</span></div>
              <div class="row"><span>Graph</span><span class="mono">{counts.modules} modules · {counts.wires} wires · {counts.groups} groups</span></div>
            </div>
            <div class="row">
              <button class="copy-diagnostics" onclick={copyDiagnostics}>{copied ? '✓ Copied' : 'Copy diagnostics'}</button>
              <label class="inline">
                <input type="checkbox" checked={tracing} onchange={(e) => setTracing(e.currentTarget.checked)} />
                Log state events to console
              </label>
            </div>
            <h3>MIDI monitor</h3>
            {#if monitor.length === 0}
              <p class="pane-note dim">No incoming MIDI yet.</p>
            {:else}
              <div class="monitor">
                {#each monitor as m, i (i)}
                  <div class="mono">{new Date(m.t).toLocaleTimeString()} · {m.deviceId} · {m.data}</div>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

{#if tutorialPrompt}
  <div class="tutorial-backdrop">
    <div class="tutorial-dialog" role="dialog" aria-label="Start tutorial">
      <p>Start the tutorial? It rearranges the patch — you can save your project first.</p>
      <div class="tutorial-actions">
        <button class="save-start" onclick={() => launchTutorial(true)}>💾 Save &amp; start</button>
        <button class="just-start" onclick={() => launchTutorial(false)}>Start without saving</button>
        <button class="cancel-tutorial" onclick={() => (tutorialPrompt = false)}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .options-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 80;
  }
  .options-dialog {
    width: min(860px, 94vw);
    height: min(560px, 88vh);
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    overflow: hidden;
  }
  .options-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--panel-border);
  }
  .options-title {
    font-weight: 700;
    color: var(--accent);
  }
  .spacer { flex: 1; }
  .options-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .options-tabs {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 8px;
    border-right: 1px solid var(--panel-border);
    background: var(--control);
    overflow-y: auto;
  }
  .options-tabs .tab {
    text-align: left;
    padding: 6px 14px;
    border: none;
    background: transparent;
    border-radius: 6px;
    color: var(--text);
    cursor: pointer;
  }
  .options-tabs .tab.active {
    background: var(--panel);
    color: var(--accent);
    font-weight: 600;
  }
  .tab-pane {
    flex: 1;
    overflow-y: auto;
    padding: 14px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .tab-pane h3 {
    margin: 8px 0 0;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .row.top { align-items: flex-start; }
  .row > span:first-child:not(.activity):not(.mono) {
    width: 160px;
    flex-shrink: 0;
    color: var(--text-dim);
  }
  .grow { flex: 1; }
  .inline {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
  .dim {
    font-size: 11px;
    color: var(--text-dim);
  }
  .mono {
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .pane-note {
    margin: 0;
    font-size: 12px;
    color: var(--text);
  }
  .pane-note.badge {
    align-self: flex-start;
    background: var(--control);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 4px 10px;
    color: var(--accent);
  }
  .pic-cell {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .opt-picture {
    max-width: 120px;
    max-height: 120px;
    border-radius: 6px;
    border: 1px solid var(--panel-border);
  }
  textarea {
    resize: vertical;
    background: var(--control);
    color: var(--text);
    border: 1px solid var(--control-border);
    border-radius: 6px;
    padding: 6px 8px;
    font: inherit;
    font-size: 12px;
  }
  .activity {
    color: var(--text-dim);
    opacity: 0.35;
  }
  .activity.blink {
    color: #52e07a;
    opacity: 1;
  }
  .shortcuts {
    border-collapse: collapse;
    font-size: 13px;
  }
  .shortcuts td {
    padding: 4px 16px 4px 0;
    border-bottom: 1px solid var(--panel-border);
  }
  .monitor {
    background: var(--control);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 180px;
    overflow-y: auto;
  }
  .debug-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .tutorial-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 90;
  }
  .tutorial-dialog {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 18px 22px;
    max-width: 360px;
  }
  .tutorial-dialog p {
    margin: 0 0 14px;
    font-size: 13px;
    color: var(--text);
  }
  .tutorial-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .save-start {
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
  }
</style>
