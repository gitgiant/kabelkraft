/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import fs from 'fs'
import http from 'http'
import type net from 'net'
import path from 'path'
import type { Plugin } from 'vite'

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

function httpRedirectPlugin(): Plugin {
  return {
    name: 'http-redirect',
    configureServer(server) {
      // Plain HTTP client hitting the HTTPS port → write raw HTTP redirect
      server.httpServer?.on('clientError', (_err, socket: net.Socket) => {
        socket.end(
          'HTTP/1.1 301 Moved Permanently\r\n' +
          'Location: https://giantbook:8080/\r\n' +
          'Content-Length: 0\r\n' +
          'Connection: close\r\n\r\n'
        )
      })

      // Port 80 redirect for http://giantbook and http://localhost
      const redirectServer = http.createServer((req, res) => {
        const host = req.headers.host?.split(':')[0] ?? 'giantbook'
        res.writeHead(301, { Location: `https://${host}:8080${req.url ?? '/'}` })
        res.end()
      })
      redirectServer.listen(80, '0.0.0.0', () => {
        console.log('  HTTP redirect: :80 → https://[host]:8080')
      })
      redirectServer.on('error', (err) => {
        console.warn(`  HTTP redirect :80 error: ${err.message}`)
      })
    },
  }
}

export default defineConfig({
  plugins: [svelte(), httpRedirectPlugin()],
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
