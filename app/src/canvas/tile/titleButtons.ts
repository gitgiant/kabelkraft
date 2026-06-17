/**
 * Data-driven title-bar buttons (CONTAINER_UNIFICATION_PLAN.md, phase 5). A
 * table keyed by module type replaces the scattered `instance.type === …`
 * switches that ModuleView's title bar used to carry: each entry yields the
 * glyph buttons (right-aligned, AI / open-roll / shrink…) plus the optional
 * double-tap toggle action for container tiles. Entries call `appState` actions
 * directly — this is the UI layer.
 */

import type { Container } from 'pixi.js';
import { addTitleButton } from './chrome';
import type { Tooltip } from '../Tooltip';
import { appState } from '../../state';

/** A right-aligned glyph button on a tile title bar. */
export interface ButtonSpec {
  glyph: string;
  tip: string[];
  onTap: () => void;
}

/** The title-bar additions for one tile: its glyph buttons (rendered
 * right-to-left) and an optional title-bar double-tap toggle (grow ↔ shrink). */
export interface TitleSpec {
  buttons: ButtonSpec[];
  toggle?: () => void;
}

/** Per-module-type title spec; absent type = a plain tile (no buttons/toggle). */
const MODULE_TITLE: Record<string, (id: string) => TitleSpec> = {
  // Composer: group-tile-style toggle — ⛶ opens the roll in place, ⤡ shrinks
  // back to the compact preview tile — plus AI clip writing.
  composer: (id) => {
    const open = appState.composerOpen.has(id);
    const toggle = () =>
      appState.composerOpen.has(id) ? appState.closeComposer(id) : appState.openComposer(id);
    return {
      toggle,
      buttons: [
        {
          glyph: open ? '⤡' : '⛶',
          tip: open
            ? ['Shrink', 'Collapse back to the compact clip tile.']
            : ['Open piano roll', 'Expand the editor inside the module.'],
          onTap: toggle,
        },
        {
          glyph: '🤖',
          tip: ['AI clip', 'Describe a melody or beat — the AI writes this clip.'],
          onTap: () => appState.requestComposerAi(id),
        },
      ],
    };
  },

  // Lyrics: AI line writing — opens the timed-sheet editor with its AI popup.
  lyrics: (id) => ({
    buttons: [
      {
        glyph: '🤖',
        tip: ['AI lyrics', 'Describe a song — the AI writes timed lyric lines.'],
        onTap: () => appState.requestLyricsAi(id),
      },
    ],
  }),

  // Visualizer: AI scene writing (🤖) plus a title-bar toggle into the graph
  // editor (in-tile, like the composer's roll); the big display keeps its ⛶.
  visualizer: (id) => ({
    toggle: () => {
      if (appState.visEditorOpen === id) appState.closeVisEditor();
      else if (appState.visualizerOpen === id) appState.closeVisualizer();
      else appState.openVisEditor(id);
    },
    buttons: [
      {
        glyph: '🤖',
        tip: ['AI visuals', 'Describe a scene — the AI rewrites this visual graph.'],
        onTap: () => appState.openVisEditor(id),
      },
    ],
  }),
};

/** Title-bar buttons + toggle for a module type (empty for plain tiles). */
export function moduleTitleSpec(type: string, id: string): TitleSpec {
  return MODULE_TITLE[type]?.(id) ?? { buttons: [] };
}

/**
 * Lay glyph buttons right-to-left from the title bar's right edge (8px in, 20px
 * apart) and return the x where the preset picker should end — just left of the
 * leftmost button. The inset is derived from the button count, killing the old
 * hardcoded per-type 44/22/4.
 */
export function layoutTitleButtons(
  host: Container,
  tooltip: Tooltip,
  w: number,
  buttons: ButtonSpec[],
): number {
  buttons.forEach((b, i) =>
    addTitleButton(host, tooltip, b.glyph, w - 8 - i * 20, b.tip, b.onTap),
  );
  return w - (buttons.length === 0 ? 4 : 22 * buttons.length);
}
