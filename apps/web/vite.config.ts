import { cpSync, createReadStream, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'
import { pwaOptions } from './vite-pwa-options.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const EXCALIDRAW_FONTS_DIR = resolve(
  __dirname,
  'node_modules/@excalidraw/excalidraw/dist/prod/fonts',
)

// Self-host the Excalidraw fonts so the app works offline and the CSP
// (default-src 'self') does not block lazy font loading. Excalidraw resolves
// font URLs as `${window.EXCALIDRAW_ASSET_PATH}fonts/<Family>/<file>.woff2`
// (asset path is set in src/excalidraw-asset-path.ts), so both build output
// and the dev server must expose the fonts at /fonts/<Family>/….
// cpSync (dereference) instead of a glob copy plugin: pnpm symlinks plus
// fast-glob base-path inference kept reproducing the node_modules prefix in
// the destination.
function excalidrawFontsPlugin(): Plugin {
  return {
    name: 'excalidraw-self-hosted-fonts',
    closeBundle() {
      cpSync(EXCALIDRAW_FONTS_DIR, resolve(__dirname, 'dist/fonts'), {
        recursive: true,
        dereference: true,
      })
    },
    configureServer(server) {
      server.middlewares.use('/fonts', (req, res, next) => {
        const relPath = normalize(decodeURIComponent(req.url ?? '')).replace(/^([/\\])+/, '')
        const filePath = join(EXCALIDRAW_FONTS_DIR, relPath)
        // Terminate the base with a separator: a bare prefix check would accept
        // sibling directories (e.g. fonts-backup). Serve regular files only so a
        // directory request cannot reach createReadStream (EISDIR crash).
        const safeBase = EXCALIDRAW_FONTS_DIR.endsWith(sep)
          ? EXCALIDRAW_FONTS_DIR
          : EXCALIDRAW_FONTS_DIR + sep
        let isFile = false
        try {
          isFile = filePath.startsWith(safeBase) && statSync(filePath).isFile()
        } catch {
          // missing file → fall through to next()
        }
        if (!isFile) {
          next()
          return
        }
        res.setHeader(
          'Content-Type',
          extname(filePath) === '.woff2' ? 'font/woff2' : 'application/octet-stream',
        )
        const stream = createReadStream(filePath)
        stream.on('error', () => {
          // Without this, a read error crashes the dev server via an
          // unhandled 'error' event on the stream.
          if (!res.headersSent) res.statusCode = 500
          res.end()
        })
        stream.pipe(res)
      })
    },
  }
}

export default defineConfig({
  resolve: {
    alias: {
      // Standard shadcn alias rooted at apps/web/src.
      '@': resolve(__dirname, 'src'),
      // Resolve browser-shared from source so `pnpm dev` works before `pnpm build`.
      '@kamiazya/whiteboard-mcp/browser-shared': resolve(
        __dirname,
        '../../packages/mcp-server/src/shared/browser-shared-index.ts',
      ),
      '@kamiazya/whiteboard-mcp/daemon-backend': resolve(
        __dirname,
        '../../packages/mcp-server/src/shared/daemon-backend.ts',
      ),
      '@kamiazya/whiteboard-mcp/api-client': resolve(
        __dirname,
        '../../packages/mcp-server/src/shared/api-client.ts',
      ),
      '@kamiazya/whiteboard-mcp/api-contracts': resolve(
        __dirname,
        '../../packages/mcp-server/src/shared/api-contracts/index.ts',
      ),
      // Declared test/internal-only subpath (not in mcp-server's published
      // npm exports) used by daemon-probe.schema-drift.test.ts to import the
      // server's runtime schema through a contract surface instead of a
      // relative deep import into another package's src/.
      '@kamiazya/whiteboard-mcp/api-contracts-internal': resolve(
        __dirname,
        '../../packages/mcp-server/src/shared/api-contracts/runtime.ts',
      ),
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
        // Deliberately NOT grouping @excalidraw/* the same way: Excalidraw's
        // own dist already dynamically imports its heavy optional features
        // (mermaid-to-excalidraw's parser, cytoscape, katex — the various
        // *Diagram-*.js / cytoscape.esm-*.js / katex-*.js chunks visible in
        // the build output). A blanket `id.includes('@excalidraw')` rule
        // merges those into one eager multi-MB chunk regardless of import
        // kind, which both defeats Excalidraw's own lazy split and blows
        // past vite-plugin-pwa's 2 MiB precache-per-file limit. Leave
        // Excalidraw's core module to whichever automatic chunk it lands in;
        // Stage 2 (deferring the whole editor page behind React.lazy) is
        // what actually keeps it out of the initial paint.
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
    // Tailwind v4 does not need PostCSS; CSS imports `tailwindcss` directly.
    tailwindcss(),
    // Required for the browser bundle that includes the Loro CRDT WASM build.
    wasm(),
    topLevelAwait(),
    // Must run after excalidrawFontsPlugin (declaration-order hint only —
    // Rollup does not guarantee closeBundle execution order; the real
    // guard is scripts/check-pwa-precache.mjs, which fails the build if the
    // generated precache manifest is missing font entries).
    excalidrawFontsPlugin(),
    VitePWA(pwaOptions),
  ],
})
