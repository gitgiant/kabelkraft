/**
 * Color themes (PRD §14 Display). Themes live in the THEMES registry keyed by
 * ThemeName, so the Display options dropdown and persistence are data-driven —
 * adding a theme is one registry entry. The exported `theme` object is mutated
 * in place on switch, so canvas code that reads it at draw time picks up new
 * colors after a rebuild. Port/wire type colors are intentionally NOT themed —
 * signal types stay readable in any theme (PRD §11.5: color = identity,
 * shape/type-color = function).
 */

import { appSettings, updateSettings, type ThemeName } from './core/settings';

export interface Theme {
  name: ThemeName;
  canvasBg: number;
  moduleBody: number;
  moduleBodySelected: number;
  moduleTitle: number;
  moduleStroke: number;
  selectedStroke: number;
  text: number;
  textDim: number;
  inset: number; // meter/waveform/step-cell backgrounds
  graphBg: number; // deepest surface: node-graph / piano-roll / visualizer canvas
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
  graphBg: 0x0c0c12,
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
    '--graph-bg': '#0c0c12',
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
  graphBg: 0xf0f0f6,
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
    '--graph-bg': '#f0f0f6',
    'color-scheme': 'light',
  },
};

// Solarized (Ethan Schoonover). base03 #002b36 base02 #073642 base01 #586e75
// base00 #657b83 base0 #839496 base1 #93a1a1 base2 #eee8d5 base3 #fdf6e3;
// accent = blue #268bd2.
export const SOLARIZED_DARK: Theme = {
  name: 'solarized-dark',
  canvasBg: 0x002b36,
  moduleBody: 0x073642,
  moduleBodySelected: 0x0a4856,
  moduleTitle: 0x0b3c49,
  moduleStroke: 0x586e75,
  selectedStroke: 0x93a1a1,
  text: 0x839496,
  textDim: 0x586e75,
  inset: 0x00212b,
  graphBg: 0x00212b,
  button: 0x0a4856,
  groupBody: 0x073642,
  groupTitle: 0x0b3c49,
  groupStroke: 0x268bd2,
  frameFill: 0x073642,
  css: {
    '--bg': '#002b36',
    '--panel': '#073642',
    '--panel-border': '#0e4a5a',
    '--control': '#073642',
    '--control-border': '#586e75',
    '--text': '#839496',
    '--text-dim': '#586e75',
    '--accent': '#268bd2',
    '--graph-bg': '#00212b',
    'color-scheme': 'dark',
  },
};

export const SOLARIZED_LIGHT: Theme = {
  name: 'solarized-light',
  canvasBg: 0xfdf6e3,
  moduleBody: 0xeee8d5,
  moduleBodySelected: 0xfdf6e3,
  moduleTitle: 0xe3dcc4,
  moduleStroke: 0x93a1a1,
  selectedStroke: 0x586e75,
  text: 0x657b83,
  textDim: 0x93a1a1,
  inset: 0xeee8d5,
  graphBg: 0xfdf6e3,
  button: 0xe3dcc4,
  groupBody: 0xeee8d5,
  groupTitle: 0xe3dcc4,
  groupStroke: 0x268bd2,
  frameFill: 0xe3dcc4,
  css: {
    '--bg': '#fdf6e3',
    '--panel': '#eee8d5',
    '--panel-border': '#d9d2bb',
    '--control': '#fdf6e3',
    '--control-border': '#93a1a1',
    '--text': '#657b83',
    '--text-dim': '#93a1a1',
    '--accent': '#268bd2',
    '--graph-bg': '#fdf6e3',
    'color-scheme': 'light',
  },
};

/** Theme registry — Display dropdown and persistence map over this. */
export const THEMES: Record<ThemeName, { label: string; theme: Theme }> = {
  dark: { label: 'Dark', theme: DARK },
  light: { label: 'Light', theme: LIGHT },
  'solarized-dark': { label: 'Solarized Dark', theme: SOLARIZED_DARK },
  'solarized-light': { label: 'Solarized Light', theme: SOLARIZED_LIGHT },
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

export function setTheme(name: ThemeName): void {
  Object.assign(theme, (THEMES[name] ?? THEMES.dark).theme);
  applyCssVars();
  updateSettings((s) => {
    s.display.theme = name;
  });
  for (const fn of listeners) fn(theme);
}

/** `0xRRGGBB` → `#rrggbb` for canvas/DOM color strings. */
export function cssHex(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
}

/** True for any light-scheme theme (light, solarized-light). */
export function isLightTheme(): boolean {
  return theme.css['color-scheme'] === 'light';
}

export function applyCssVars(): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.css)) {
    if (key === 'color-scheme') root.style.colorScheme = value;
    else root.style.setProperty(key, value);
  }
}

export function initTheme(): void {
  Object.assign(theme, (THEMES[appSettings().display.theme] ?? THEMES.dark).theme);
  applyCssVars();
}
