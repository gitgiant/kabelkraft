/**
 * Color themes (PRD §14 Display): dark (default) and light. The exported
 * `theme` object is mutated in place on switch, so canvas code that reads it
 * at draw time picks up new colors after a rebuild. Port/wire type colors are
 * intentionally NOT themed — signal types stay readable in any theme
 * (PRD §11.5: color = identity, shape/type-color = function).
 */

import { appSettings, updateSettings } from './core/settings';

export interface Theme {
  name: 'dark' | 'light';
  canvasBg: number;
  moduleBody: number;
  moduleBodySelected: number;
  moduleTitle: number;
  moduleStroke: number;
  selectedStroke: number;
  text: number;
  textDim: number;
  inset: number; // meter/waveform/step-cell backgrounds
  button: number;
  groupBody: number;
  groupTitle: number;
  groupStroke: number;
  frameFill: number;
  /** CSS variables for the Svelte chrome. */
  css: Record<string, string>;
}

export const DARK: Theme = {
  name: 'dark',
  canvasBg: 0x17171c,
  moduleBody: 0x26262e,
  moduleBodySelected: 0x32323e,
  moduleTitle: 0x33333d,
  moduleStroke: 0x4a4a58,
  selectedStroke: 0xffffff,
  text: 0xd8d8e0,
  textDim: 0x9090a0,
  inset: 0x16161c,
  button: 0x3a3a48,
  groupBody: 0x222230,
  groupTitle: 0x33334a,
  groupStroke: 0x5a5a78,
  frameFill: 0x2a2a3a,
  css: {
    '--bg': '#17171c',
    '--panel': '#1f1f26',
    '--panel-border': '#34343f',
    '--control': '#26262e',
    '--control-border': '#3a3a48',
    '--text': '#d8d8e0',
    '--text-dim': '#9090a0',
    '--accent': '#ffb13d',
    'color-scheme': 'dark',
  },
};

export const LIGHT: Theme = {
  name: 'light',
  canvasBg: 0xe9e9ef,
  moduleBody: 0xfafafc,
  moduleBodySelected: 0xffffff,
  moduleTitle: 0xdcdce6,
  moduleStroke: 0xb8b8c8,
  selectedStroke: 0x222230,
  text: 0x26262e,
  textDim: 0x6a6a7a,
  inset: 0xd8d8e2,
  button: 0xcccdd8,
  groupBody: 0xf0f0f8,
  groupTitle: 0xd4d4e4,
  groupStroke: 0x8a8aa8,
  frameFill: 0xc8c8da,
  css: {
    '--bg': '#e9e9ef',
    '--panel': '#f4f4f8',
    '--panel-border': '#c8c8d4',
    '--control': '#ffffff',
    '--control-border': '#b8b8c8',
    '--text': '#26262e',
    '--text-dim': '#6a6a7a',
    '--accent': '#c77800',
    'color-scheme': 'light',
  },
};

/** Group tint cycle (PRD §6 rename/recolor); undefined = theme default. */
export const GROUP_COLORS: Array<number | undefined> = [
  undefined, 0xff5050, 0xffb13d, 0x52e07a, 0x3dd9ff, 0x6a8aff, 0xb070ff, 0xff3dd0,
];

export function nextGroupColor(current: number | undefined): number | undefined {
  const idx = GROUP_COLORS.indexOf(current);
  return GROUP_COLORS[(idx + 1) % GROUP_COLORS.length];
}

/** Live theme — mutated in place by setTheme. */
export const theme: Theme = { ...DARK };

type ThemeListener = (t: Theme) => void;
const listeners = new Set<ThemeListener>();

export function onThemeChange(fn: ThemeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setTheme(name: 'dark' | 'light'): void {
  Object.assign(theme, name === 'light' ? LIGHT : DARK);
  applyCssVars();
  updateSettings((s) => {
    s.display.theme = name;
  });
  for (const fn of listeners) fn(theme);
}

export function applyCssVars(): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.css)) {
    if (key === 'color-scheme') root.style.colorScheme = value;
    else root.style.setProperty(key, value);
  }
}

export function initTheme(): void {
  Object.assign(theme, appSettings().display.theme === 'light' ? LIGHT : DARK);
  applyCssVars();
}
