import { cpSync, createReadStream, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'

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
      '@kamiazya/whiteboard-mcp/migration-bundle': resolve(
        __dirname,
        '../../packages/mcp-server/src/shared/migration-bundle.ts',
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
    excalidrawFontsPlugin(),
  ],
})
