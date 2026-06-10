/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 8080,
    host: '0.0.0.0',
    allowedHosts: ['giantbook'],
  },
  test: {
    include: ['src/**/*.test.ts'], // e2e/ belongs to Playwright
  },
})
