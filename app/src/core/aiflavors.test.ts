import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_FLAVORS, aiInputEnabled, setAiInputEnabled } from './aiflavors';
import { appSettings, resetSettingsCache } from './settings';

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
afterEach(() => resetSettingsCache());

describe('aiInputEnabled', () => {
  it('falls back to the registry default when unset', () => {
    expect(aiInputEnabled('midi', 'transport')).toBe(true);
    expect(aiInputEnabled('midi', 'existingNotes')).toBe(false);
    expect(aiInputEnabled('patch', 'canvas')).toBe(false);
    expect(aiInputEnabled('patch', 'groupConfig')).toBe(true);
  });

  it('returns false for an unknown input', () => {
    expect(aiInputEnabled('midi', 'nope')).toBe(false);
  });

  it('honors a stored override over the default', () => {
    setAiInputEnabled('midi', 'transport', false);
    expect(aiInputEnabled('midi', 'transport')).toBe(false);
    setAiInputEnabled('patch', 'canvas', true);
    expect(aiInputEnabled('patch', 'canvas')).toBe(true);
  });

  it('persists overrides through the settings store', () => {
    setAiInputEnabled('lyrics', 'songLength', false);
    resetSettingsCache(); // force a reload from localStorage
    expect(appSettings().ai.inputs?.lyrics?.songLength).toBe(false);
    expect(aiInputEnabled('lyrics', 'songLength')).toBe(false);
  });
});

describe('AI_FLAVORS registry', () => {
  it('covers all seven flavors with unique input ids', () => {
    expect(AI_FLAVORS.map((f) => f.id).sort()).toEqual(
      ['face', 'lyrics', 'midi', 'patch', 'preset', 'project', 'visual'].sort(),
    );
    for (const f of AI_FLAVORS) {
      const ids = f.inputs.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(f.description.length).toBeGreaterThan(0);
    }
  });
});
