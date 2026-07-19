import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // Resolve browser-shared from source so tests run before `pnpm build`.
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
      // Subpath alias must precede the root alias: rollup-alias prefix-matches,
      // so the root entry alone would rewrite '/scene' to 'index.ts/scene'.
      '@kamiazya/whiteboard-canvas-viewer/scene': resolve(
        __dirname,
        '../../packages/canvas-viewer/src/scene.ts',
      ),
      // Resolve canvas-viewer from source so tests run before `pnpm build`.
      '@kamiazya/whiteboard-canvas-viewer': resolve(
        __dirname,
        '../../packages/canvas-viewer/src/index.ts',
      ),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // *.docs-snapshot.test.tsx files run only via `pnpm docs:snapshots`
    // (vitest.docs-snapshots.config.ts) — they write PNGs into the repo
    // and need real browser mode, not jsdom.
    exclude: [
      'src/**/*.browser.test.ts',
      'src/**/*.browser.test.tsx',
      'src/**/*.docs-snapshot.test.tsx',
    ],
  },
})
