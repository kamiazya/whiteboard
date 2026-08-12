import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import svgr from 'vite-plugin-svgr'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'
import { mcpSourceAlias } from './mcp-source-alias.js'
import { cloudflareDevHeadersPlugin } from './vite-dev-headers.js'
import { stripWasmSourceMapPlugin } from './vite-plugin-strip-wasm-sourcemap.js'
import { pwaOptions } from './vite-pwa-options.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      ...mcpSourceAlias,
      // Standard shadcn alias rooted at apps/web/src.
      '@': resolve(__dirname, 'src'),
      // loro-crdt's export map resolves the production browser build to its
      // `browser/` entry, which loads the WASM via a SYNCHRONOUS XHR. Sync
      // XHR bypasses the service worker, so the precached WASM is never
      // served offline and the PWA dies on reload without network. Pin the
      // `bundler/` entry (an ESM `import ... from '*.wasm'` handled by
      // vite-plugin-wasm as an async, SW-interceptable fetch) — the same
      // entry vite already uses in dev via the `browser.development`
      // condition, so dev and prod behavior converge.
      'loro-crdt': 'loro-crdt/bundler',
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        // The bundle-size gate (scripts/smoke-bundle-size.mjs) matches this
        // lazy chunk by a fixed `daemon-canvas-*.js` prefix. Without an
        // explicit name here, Rollup names it after the source file
        // (`DaemonCanvasPage-<hash>.js`), which the gate's pattern never
        // matches — silently skipping the budget instead of enforcing it.
        chunkFileNames: (chunkInfo) =>
          chunkInfo.name === 'DaemonCanvasPage'
            ? 'assets/daemon-canvas-[hash].js'
            : 'assets/[name]-[hash].js',
        // Isolate React into its own named vendor chunk instead of letting
        // Rollup's automatic chunking scatter it across shared chunks. This
        // does not shrink total transfer on its own — it separates what
        // changes (app code) from what doesn't (vendor code), so a deploy
        // that only touches app code doesn't invalidate the (much larger)
        // vendor cache.
        //
        // Deliberately NOT doing the same for loro-crdt (dropped after
        // apps/web/scripts/smoke-bundle-size.mjs caught it regressing the
        // critical path back to ~120KB): loro-crdt is only ever imported from
        // lazy-reachable modules (useCanvasSync, browser-local-backend, the
        // migration import panel), so Rollup's automatic chunking already
        // isolates it into a chunk those lazy consumers share — no manual
        // rule needed. Forcing it into one named `vendor-loro-crdt` chunk
        // made vite-plugin-top-level-await's own shared dynamic-import
        // helper (used to sequence every React.lazy() call against any
        // in-flight top-level await) land in the SAME physical chunk as
        // loro's WASM bindings, because that helper has no manual-chunk
        // assignment of its own and Rollup co-locates unassigned shared
        // modules with whichever named chunk also needs them. Since the
        // entry imports that helper synchronously for its own React.lazy()
        // calls, and the top-level-await plugin requires every importer of
        // a TLA-bearing chunk to also import (and await) its `__tla` export,
        // the entry ended up eagerly loading the whole vendor-loro-crdt
        // chunk through a dependency that had nothing to do with loro.
        //
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('scheduler')) {
            return 'vendor-react'
          }
          return undefined
        },
      },
    },
  },
  plugins: [
    react(),
    svgr(),
    // Tailwind v4 does not need PostCSS; CSS imports `tailwindcss` directly.
    tailwindcss(),
    // Required for the browser bundle that includes the Loro CRDT WASM build.
    wasm(),
    topLevelAwait(),
    // Must run before VitePWA: see stripWasmSourceMapPlugin's doc comment —
    // VitePWA hashes dist/ contents for the precache manifest in closeBundle,
    // so the wasm bytes must already be stripped when that hook runs.
    stripWasmSourceMapPlugin(),
    // Production _headers parity in dev/preview responses — a CSP gap must
    // reproduce locally, not first on the deployed Pages origin.
    cloudflareDevHeadersPlugin(),
    VitePWA(pwaOptions),
  ],
})
