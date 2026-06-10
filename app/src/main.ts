import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { appState } from './state'
import { initTheme } from './theme'

initTheme()

const app = mount(App, {
  target: document.getElementById('app')!,
})

// Test hook: lets Playwright e2e tests inspect live state (PRD §18).
declare global {
  interface Window {
    __kk: typeof appState
  }
}
window.__kk = appState

export default app
