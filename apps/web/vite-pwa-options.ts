import type { VitePWAOptions } from 'vite-plugin-pwa'

const THEME_COLOR = '#0f172a'
const BACKGROUND_COLOR = '#ffffff'
const ONE_MIB = 1024 * 1024

// vite-plugin-pwa options for the browser-local app shell.
//
// registerType 'prompt' (not 'autoUpdate'): silently swapping the
// service-worker-controlled bundle under a user mid-draw on the canvas risks
// losing in-flight edit state. The user opts into reload via the in-app
// update toast instead (see src/pwa/UpdateToast.tsx).
//
// No `workbox.runtimeCaching` and a `navigateFallbackDenylist` covering
// same-origin daemon/API prefixes: the service worker must never intercept a
// fetch bound for the daemon (loopback or same-origin `/mcp`, `/ws`, `/api`).
// Daemon-paired mode requires the *document* to originate the loopback fetch
// so Local Network Access permission prompts and CORS behave correctly — an
// SW sitting in the fetch path breaks or silently bypasses that.
export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: 'prompt',
  manifest: {
    name: 'Whiteboard',
    short_name: 'Whiteboard',
    display: 'standalone',
    start_url: '/',
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  },
  workbox: {
    // wasm: the browser-local editor loads loro-crdt's WASM module; without
    // it in the precache manifest an installed/offline PWA loads the JS
    // shell but fails the moment it needs Loro. ttf: the app's only font
    // (the vendored Roboto face canvas-viewer's measurer and mcp-server's
    // exporter both measure) ships as a .ttf, not .woff2 — without it here
    // an installed offline PWA has no precached font at all and silently
    // falls back to a system face, diverging from exported metrics.
    globPatterns: ['**/*.{js,css,html,woff2,ttf,png,svg,ico,wasm}'],
    navigateFallbackDenylist: [/^\/api(\/|$)/, /^\/mcp(\/|$)/, /^\/ws(\/|$)/],
    // Workbox's 2 MiB default would silently drop the entry chunk (~560 KB
    // gzip, larger uncompressed) from the precache manifest with only a
    // build-time warning. Raised so the app shell always precaches in full.
    maximumFileSizeToCacheInBytes: 4 * ONE_MIB,
  },
}
