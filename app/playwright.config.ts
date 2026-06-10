import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from '@playwright/test';

// vite.config.ts switches the dev server to HTTPS when ../key.pem + ../cert.pem
// exist (device testing); mirror that here so e2e targets the right scheme.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const https =
  fs.existsSync(path.join(rootDir, 'key.pem')) && fs.existsSync(path.join(rootDir, 'cert.pem'));
const origin = `${https ? 'https' : 'http'}://localhost:5199`;

export default defineConfig({
  testDir: './e2e',
  use: {
    channel: 'chrome', // system Chrome; no browser download needed
    baseURL: origin,
    ignoreHTTPSErrors: true, // self-signed local cert
    launchOptions: {
      // Keep the audio render clock running in headless test runs even when
      // no real output device is available (frozen AudioContext otherwise).
      args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    command: 'npm run dev -- --port 5199 --strictPort',
    url: origin,
    reuseExistingServer: true,
    ignoreHTTPSErrors: true,
  },
});
