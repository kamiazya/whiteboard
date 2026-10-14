import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import svgr from 'vite-plugin-svgr'
import wasm from 'vite-plugin-wasm'
import { rendererBuildDefine } from './renderer-build-id.js'
import { createCodeSplittingGroups } from './vite-code-splitting.js'
import { cloudflareDevHeadersPlugin } from './vite-dev-headers.js'
import { stripWasmSourceMapPlugin } from './vite-plugin-strip-wasm-sourcemap.js'
import { pwaOptions } from './vite-pwa-options.js'
import { workerSafeDepsAlias } from './worker-safe-deps-alias.js'

export default defineConfig({
  define: { ...rendererBuildDefine },
  // Both workers are constructed with `type: 'module'`, but Vite's default
  // worker output is `iife` — which happened to run anyway, since a module
  // worker executes IIFE code fine. It stops being harmless the moment a
  // worker needs a dependency with top-level await: loro-crdt's WASM init has
  // one, and `iife` cannot express it, so the build fails with
  // UNSUPPORTED_FEATURE pointing at a file nobody here wrote.
  worker: { format: 'es' },
  resolve: {
    alias: {
      // loro-crdt's export map resolves the production browser build to its
      // `browser/` entry, which loads the WASM via a SYNCHRONOUS XHR. Sync
      // XHR bypasses the service worker, so the precached WASM is never
      // served offline and the PWA dies on reload without network. Pin the
      // `bundler/` entry (an ESM `import ... from '*.wasm'` handled by
      // vite-plugin-wasm as an async, SW-interceptable fetch) — the same
      // entry vite already uses in dev via the `browser.development`
      // condition, so dev and prod behavior converge.
      'loro-crdt': 'loro-crdt/bundler',
      // Without these, importing remark in a worker throws
      // `document is not defined` at chunk evaluation — see the module.
      ...workerSafeDepsAlias,
    },
  },
  build: {
    target: 'esnext',
    // Just above the largest chunk (the lazy svg renderer, ~1.26 MB): the
    // editor, the renderer and mermaid are big by design and load lazily, so
    // Vite's 500 kB default only taught everyone to skip its warning. The
    // enforced budgets are scripts/smoke-bundle-size.mjs (first paint) and
    // scripts/check-pwa-precache.mjs (what the service worker caches).
    chunkSizeWarningLimit: 1300,
    rolldownOptions: {
      output: {
        // The bundle-size gate (scripts/smoke-bundle-size.mjs) matches this
        // lazy chunk by a fixed `daemon-document-*.js` prefix. Without an
        // explicit name here, rolldown names it after the source file
        // (`DaemonDocumentPage-<hash>.js`), which the gate's pattern never
        // matches — silently skipping the budget instead of enforcing it.
        chunkFileNames: (chunkInfo) =>
          chunkInfo.name === 'DaemonDocumentPage'
            ? 'assets/daemon-document-[hash].js'
            : 'assets/[name]-[hash].js',
        // Which modules share a chunk, and the hazards behind each group:
        // see vite-code-splitting.ts.
        codeSplitting: { groups: createCodeSplittingGroups() },
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
