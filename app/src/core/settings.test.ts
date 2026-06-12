import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SETTINGS_KEY,
  appSettings,
  defaultSettings,
  onSettingsChange,
  resetSettingsCache,
  sanitizeSettings,
  updateSettings,
} from './settings';

// Minimal in-memory localStorage (vitest runs under node, no DOM).
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

beforeEach(() => {
  store.clear();
  resetSettingsCache();
});

afterEach(() => {
  resetSettingsCache();
});

describe('unified settings store', () => {
  it('returns defaults on first run and persists them', () => {
    const s = appSettings();
    expect(s.display.theme).toBe('dark');
    expect(s.general.defaultTempo).toBe(120);
    expect(s.audio.latencyHint).toBe('interactive');
    expect(localStorage.getItem(SETTINGS_KEY)).toBeTruthy();
  });

  it('round-trips updates through localStorage', () => {
    updateSettings((s) => {
      s.display.theme = 'light';
      s.general.defaultTempo = 90;
    });
    resetSettingsCache();
    const s = appSettings();
    expect(s.display.theme).toBe('light');
    expect(s.general.defaultTempo).toBe(90);
  });

  it('notifies listeners on change', () => {
    const seen: string[] = [];
    const off = onSettingsChange((s) => seen.push(s.display.theme));
    updateSettings((s) => {
      s.display.theme = 'light';
    });
    off();
    updateSettings((s) => {
      s.display.theme = 'dark';
    });
    expect(seen).toEqual(['light']);
  });

  it('migrates the legacy kk-theme and kk-ai-settings keys, then removes them', () => {
    localStorage.setItem('kk-theme', 'light');
    localStorage.setItem(
      'kk-ai-settings',
      JSON.stringify({ provider: 'claude', claude: { apiKey: 'sk-x', model: 'claude-opus-4-8' } }),
    );
    const s = appSettings();
    expect(s.display.theme).toBe('light');
    expect(s.ai.provider).toBe('claude');
    expect(s.ai.claude.apiKey).toBe('sk-x');
    expect(localStorage.getItem('kk-theme')).toBeNull();
    expect(localStorage.getItem('kk-ai-settings')).toBeNull();
  });

  it('survives a corrupt stored record', () => {
    localStorage.setItem(SETTINGS_KEY, '{nope');
    expect(appSettings().display.theme).toBe('dark');
  });

  it('sanitize clamps ranges and rejects foreign values', () => {
    const s = sanitizeSettings({
      display: { theme: 'neon', uiScale: 99, visMaxFps: -5, visMaxRes: 2 },
      general: { defaultTempo: 10000, confirmLeave: 'yes', autosaveInterval: 1 },
      audio: { latencyHint: 'turbo', sampleRate: 12345, masterGain: 9, muted: 1 },
      midi: { disabledInputs: ['a', 7, 'b'] },
    });
    expect(s.display.theme).toBe('dark');
    expect(s.display.uiScale).toBe(1.5);
    expect(s.display.visMaxFps).toBe(1);
    expect(s.display.visMaxRes).toBe(1);
    expect(s.general.defaultTempo).toBe(300);
    expect(s.general.confirmLeave).toBe(false);
    expect(s.general.autosaveInterval).toBe(5);
    expect(s.general.qwertyPiano).toBe(true); // absent → default on
    expect(s.audio.latencyHint).toBe('interactive');
    expect(s.audio.sampleRate).toBe(0);
    expect(s.audio.masterGain).toBe(1.5);
    expect(s.audio.muted).toBe(false);
    expect(s.midi.disabledInputs).toEqual(['a', 'b']);
  });

  it('updateSettings re-sanitizes the mutation', () => {
    updateSettings((s) => {
      s.general.defaultTempo = -50;
    });
    expect(appSettings().general.defaultTempo).toBe(20);
  });

  it('defaultSettings returns independent copies', () => {
    const a = defaultSettings();
    a.ai.claude.apiKey = 'mutated';
    expect(defaultSettings().ai.claude.apiKey).toBe('');
  });
});
