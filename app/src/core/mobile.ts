/**
 * Touch controls mode: detection + the Options → Display override.
 *
 * "Touch mode" switches the chrome to mobile-friendly behavior: side panels
 * become overlay drawers, hit targets fatten (port dots, wire picking,
 * hide/show grips), and the canvas gains touch gestures (two/three-finger
 * tap undo/redo, long-press multi-select, double-tap zoom-to-fit, edge
 * swipes). Visual sizes are unchanged — only interaction changes.
 */

import { appSettings, onSettingsChange, type TouchModePref } from './settings';

/** A coarse primary pointer that can actually touch — phones and tablets. */
export function detectTouchDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return (
    (navigator.maxTouchPoints ?? 0) > 0 &&
    window.matchMedia?.('(pointer: coarse)')?.matches === true
  );
}

/** Pure resolution of the preference against the detection result. */
export function resolveTouchMode(pref: TouchModePref, detected: boolean): boolean {
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return detected;
}

type TouchModeListener = (on: boolean) => void;
const listeners = new Set<TouchModeListener>();
let current: boolean | null = null;
let wired = false;

function recompute(): void {
  const next = resolveTouchMode(appSettings().display.touchMode, detectTouchDevice());
  if (next === current) return;
  current = next;
  for (const l of listeners) l(next);
}

/** Lazily wire the inputs that can flip the mode (settings, pointer change). */
function ensureWired(): void {
  if (wired) return;
  wired = true;
  onSettingsChange(recompute);
  if (typeof window !== 'undefined' && window.matchMedia) {
    // Tablets flip between coarse/fine when a trackpad/keyboard (dis)connects.
    window.matchMedia('(pointer: coarse)').addEventListener?.('change', recompute);
  }
}

/** Whether touch controls are active right now. */
export function isTouchMode(): boolean {
  ensureWired();
  if (current === null) {
    current = resolveTouchMode(appSettings().display.touchMode, detectTouchDevice());
  }
  return current;
}

/** Subscribe to mode flips (settings override or pointer capability change). */
export function onTouchModeChange(fn: TouchModeListener): () => void {
  ensureWired();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test hook: forget the cached mode so the next read re-resolves. */
export function resetTouchModeCache(): void {
  current = null;
}
