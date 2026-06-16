import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

import { getExcalidrawFontCopyTarget } from './src/server/excalidraw-font-assets.js'
import { runtimeConfigDevPlugin } from './scripts/vite-dev-token-plugin.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: 'src/app',
  build: {
    outDir: '../../dist/app',
    emptyOutDir: true,
    target: 'esnext',
  },
  resolve: {
    alias: {
      // Standard shadcn alias for imports rooted at src/app.
      '@': resolve(__dirname, 'src/app'),
    },
  },
  plugins: [
    react(),
    // Tailwind v4 does not need PostCSS; CSS imports `tailwindcss` directly.
    tailwindcss(),
    // Required for the browser bundle that includes the Loro CRDT WASM build.
    wasm(),
    topLevelAwait(),
    viteStaticCopy({
      targets: [
        // Self-host the Excalidraw fonts.
        getExcalidrawFontCopyTarget(__dirname),
      ],
    }),
    // Dev-only: injects window.__WHITEBOARD_RUNTIME_CONFIG__ so apiFetch
    // sends Authorization: Bearer <token> on every /api/* request.
    // apply: 'serve' inside the plugin ensures this never reaches production.
    runtimeConfigDevPlugin(),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3099',
      '/ws': { target: 'ws://localhost:3099', ws: true },
    },
  },
})
