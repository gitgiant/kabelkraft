/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import fs from 'fs'
import path from 'path'

const rootDir = path.resolve(__dirname, '..')
const keyPath = path.join(rootDir, 'key.pem')
const certPath = path.join(rootDir, 'cert.pem')

// https://vite.dev/config/
// crossOriginIsolated unlocks SharedArrayBuffer — the visual engine's audio
// ring (src/visual/ring.ts). Hosting must send the same two headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 8080,
    host: '0.0.0.0',
    allowedHosts: ['giantbook'],
    headers: isolationHeaders,
    https: fs.existsSync(keyPath) && fs.existsSync(certPath) ? {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    } : undefined,
  },
  preview: {
    headers: isolationHeaders,
  },
  test: {
    include: ['src/**/*.test.ts'], // e2e/ belongs to Playwright
  },
})
