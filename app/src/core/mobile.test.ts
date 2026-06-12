import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectTouchDevice,
  isTouchMode,
  onTouchModeChange,
  resetTouchModeCache,
  resolveTouchMode,
} from './mobile';
import { resetSettingsCache, updateSettings } from './settings';

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
  resetTouchModeCache();
});

describe('touch mode resolution', () => {
  it('override wins over detection', () => {
    expect(resolveTouchMode('on', false)).toBe(true);
    expect(resolveTouchMode('off', true)).toBe(false);
  });

  it('auto follows detection', () => {
    expect(resolveTouchMode('auto', true)).toBe(true);
    expect(resolveTouchMode('auto', false)).toBe(false);
  });

  it('detection is safely false without a DOM', () => {
    expect(detectTouchDevice()).toBe(false);
  });

  it('isTouchMode applies the settings override and notifies on flips', () => {
    expect(isTouchMode()).toBe(false); // auto + no DOM detection
    const flips: boolean[] = [];
    const off = onTouchModeChange((on) => flips.push(on));
    updateSettings((s) => {
      s.display.touchMode = 'on';
    });
    expect(isTouchMode()).toBe(true);
    updateSettings((s) => {
      s.display.touchMode = 'off';
    });
    expect(isTouchMode()).toBe(false);
    off();
    expect(flips).toEqual([true, false]);
  });
});
