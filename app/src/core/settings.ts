/**
 * Unified app settings (OPTIONS_MENU_PLAN.md) — one versioned localStorage
 * key for every machine-level preference: display, general behavior, and the
 * AI backend. Per-project state never lives here; it belongs in the .kkproj.
 *
 * First load migrates the legacy scattered keys ('kk-theme', 'kk-ai-settings')
 * into the unified record and removes them.
 */

import { DEFAULT_SETTINGS as DEFAULT_AI_SETTINGS, sanitizeAiSettings, type AiSettings } from './aisettings';

export type ThemeName = 'dark' | 'light' | 'solarized-dark' | 'solarized-light';

const THEME_NAMES: readonly ThemeName[] = ['dark', 'light', 'solarized-dark', 'solarized-light'];

/** Touch controls: auto-detect a coarse pointer, or force on/off. */
export type TouchModePref = 'auto' | 'on' | 'off';

export interface DisplaySettings {
  theme: ThemeName;
  /** Chrome zoom factor (canvas included), 0.75–1.5. */
  uiScale: number;
  /** Machine-wide visualizer ceilings, clamping each container's own settings. */
  visMaxFps: number;
  visMaxRes: number;
  /** Touch controls mode (drawers, fat hit targets, gestures). */
  touchMode: TouchModePref;
}

export interface GeneralSettings {
  /** Tempo a fresh session starts with (PRD default 120). */
  defaultTempo: number;
  /** Ask before leaving the page (unsaved-work guard). */
  confirmLeave: boolean;
  /** Crash-safety autosave to IndexedDB (full project incl. samples). */
  autosave: boolean;
  /** Seconds between autosave writes. */
  autosaveInterval: number;
  /** QWERTY-as-piano (PRD §8.6): A-row plays notes on keyboard modules. */
  qwertyPiano: boolean;
  /** Auto-run the layered Arrange layout when a group is expanded/collapsed. */
  autoArrangeOnToggle: boolean;
}

export interface AudioSettings {
  latencyHint: 'interactive' | 'balanced' | 'playback';
  /** Requested AudioContext rate; 0 = browser default. */
  sampleRate: number;
  /** Output device id (AudioContext.setSinkId); '' = system default. */
  sinkId: string;
  /** Default capture device for Audio In modules; '' = system default. */
  inputId: string;
  /** Master output gain 0–1.5 (post-worklet GainNode). */
  masterGain: number;
  muted: boolean;
}

export interface MidiSettings {
  /** Input device ids whose messages are ignored. */
  disabledInputs: string[];
}

export interface AppSettings {
  version: 1;
  display: DisplaySettings;
  general: GeneralSettings;
  audio: AudioSettings;
  midi: MidiSettings;
  ai: AiSettings;
}

export const SETTINGS_KEY = 'kk-settings';
const LEGACY_THEME_KEY = 'kk-theme';
const LEGACY_AI_KEY = 'kk-ai-settings';

export const UI_SCALES = [0.75, 0.9, 1, 1.1, 1.25, 1.5] as const;

export function defaultSettings(): AppSettings {
  return {
    version: 1,
    display: { theme: 'dark', uiScale: 1, visMaxFps: 240, visMaxRes: 1, touchMode: 'auto' },
    general: { defaultTempo: 120, confirmLeave: false, autosave: true, autosaveInterval: 30, qwertyPiano: true, autoArrangeOnToggle: false },
    audio: { latencyHint: 'interactive', sampleRate: 0, sinkId: '', inputId: '', masterGain: 1, muted: false },
    midi: { disabledInputs: [] },
    ai: structuredClone(DEFAULT_AI_SETTINGS),
  };
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Normalize a stored (possibly partial/foreign) record into valid settings. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const s = raw as Partial<AppSettings>;
  return {
    version: 1,
    display: {
      theme: THEME_NAMES.includes(s.display?.theme as ThemeName) ? (s.display!.theme as ThemeName) : 'dark',
      uiScale: clamp(s.display?.uiScale, 0.75, 1.5, d.display.uiScale),
      visMaxFps: clamp(s.display?.visMaxFps, 1, 240, d.display.visMaxFps),
      visMaxRes: clamp(s.display?.visMaxRes, 0.25, 1, d.display.visMaxRes),
      touchMode: ['auto', 'on', 'off'].includes(s.display?.touchMode as string)
        ? (s.display!.touchMode as TouchModePref)
        : 'auto',
    },
    general: {
      defaultTempo: clamp(s.general?.defaultTempo, 20, 300, d.general.defaultTempo),
      confirmLeave: s.general?.confirmLeave === true,
      autosave: s.general?.autosave !== false,
      autosaveInterval: clamp(s.general?.autosaveInterval, 5, 600, d.general.autosaveInterval),
      qwertyPiano: s.general?.qwertyPiano !== false,
      autoArrangeOnToggle: s.general?.autoArrangeOnToggle === true,
    },
    audio: {
      latencyHint: ['interactive', 'balanced', 'playback'].includes(s.audio?.latencyHint as string)
        ? (s.audio!.latencyHint as AudioSettings['latencyHint'])
        : d.audio.latencyHint,
      sampleRate: [0, 44100, 48000, 88200, 96000].includes(Number(s.audio?.sampleRate))
        ? Number(s.audio!.sampleRate)
        : d.audio.sampleRate,
      sinkId: typeof s.audio?.sinkId === 'string' ? s.audio.sinkId : '',
      inputId: typeof s.audio?.inputId === 'string' ? s.audio.inputId : '',
      masterGain: clamp(s.audio?.masterGain, 0, 1.5, d.audio.masterGain),
      muted: s.audio?.muted === true,
    },
    midi: {
      disabledInputs: Array.isArray(s.midi?.disabledInputs)
        ? s.midi.disabledInputs.filter((x): x is string => typeof x === 'string')
        : [],
    },
    ai: sanitizeAiSettings(s.ai),
  };
}

let cached: AppSettings | null = null;

type SettingsListener = (s: AppSettings) => void;
const listeners = new Set<SettingsListener>();

export function onSettingsChange(fn: SettingsListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function persist(s: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable — settings just won't survive a reload
  }
}

/** The live settings record (cached; all writes must go through updateSettings). */
export function appSettings(): AppSettings {
  if (cached) return cached;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    // ignore
  }
  if (raw) {
    try {
      cached = sanitizeSettings(JSON.parse(raw));
      return cached;
    } catch {
      // corrupt record — fall through to defaults + legacy migration
    }
  }
  const s = defaultSettings();
  try {
    if (localStorage.getItem(LEGACY_THEME_KEY) === 'light') s.display.theme = 'light';
    const legacyAi = localStorage.getItem(LEGACY_AI_KEY);
    if (legacyAi) s.ai = sanitizeAiSettings(JSON.parse(legacyAi));
    persist(s);
    localStorage.removeItem(LEGACY_THEME_KEY);
    localStorage.removeItem(LEGACY_AI_KEY);
  } catch {
    // ignore — defaults stand
  }
  cached = s;
  return cached;
}

/** Mutate-and-save: apply `fn` to the live record, re-sanitize, persist, notify. */
export function updateSettings(fn: (s: AppSettings) => void): AppSettings {
  const s = appSettings();
  fn(s);
  cached = sanitizeSettings(s);
  persist(cached);
  for (const l of listeners) l(cached);
  return cached;
}

/** Test hook: drop the cache so the next read hits storage again. */
export function resetSettingsCache(): void {
  cached = null;
}
