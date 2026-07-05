import { cpSync, existsSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
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
        // join+normalize keeps traversal inside the fonts dir; double-check anyway.
        if (!filePath.startsWith(EXCALIDRAW_FONTS_DIR) || !existsSync(filePath)) {
          next()
          return
        }
        res.setHeader(
          'Content-Type',
          extname(filePath) === '.woff2' ? 'font/woff2' : 'application/octet-stream',
        )
        createReadStream(filePath).pipe(res)
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
    },
  },
  build: {
    target: 'esnext',
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
