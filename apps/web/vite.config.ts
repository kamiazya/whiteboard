import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
    viteStaticCopy({
      targets: [
        {
          // Self-host the Excalidraw fonts so the app works offline.
          // The glob pattern starts after the fonts/ directory so the
          // dest only contains the font family subdirectories, not the
          // full node_modules path prefix.
          // fast-glob (used by vite-plugin-static-copy) requires forward
          // slashes even on Windows; replace OS separators before appending.
          src: `${resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
            .split(sep)
            .join('/')}/**/*`,
          dest: 'fonts',
        },
      ],
    }),
  ],
})
