import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { patchCanvas } from './canvas/PatchCanvas'
import { MODULE_DEFS } from './core/registry'
import { appState } from './state'
import { STARTERS } from './ui/starters'
import { VIS_NODE_DEFS } from './visual/registry'
import { initTheme } from './theme'

initTheme()

const app = mount(App, {
  target: document.getElementById('app')!,
})

// Test hook: lets Playwright e2e tests inspect live state (PRD §18).
declare global {
  interface Window {
    __kk: typeof appState
    __kkCanvas: typeof patchCanvas
    __kkMeta: { moduleDefCount: number; starterCount: number; visNodeDefCount: number }
  }
}
window.__kk = appState
window.__kkCanvas = patchCanvas
window.__kkMeta = {
  moduleDefCount: MODULE_DEFS.size,
  starterCount: STARTERS.length,
  visNodeDefCount: VIS_NODE_DEFS.size,
}

export default app
