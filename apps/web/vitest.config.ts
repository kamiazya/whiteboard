import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'
import { defineConfig } from 'vitest/config'
import { mcpSourceAlias } from './mcp-source-alias.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  resolve: {
    alias: {
      ...mcpSourceAlias,
      '@': resolve(__dirname, 'src'),
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
    setupFiles: ['./vitest.setup.ts'],
    // Safety net behind vitest.setup.ts's scheduler drain: React's scheduler
    // can still fire deferred work after jsdom teardown (window gone →
    // ReferenceError) from component timers the drain window missed. That
    // race is environmental, not a test failure — log it but do not fail the
    // run. Deliberately narrow (this exact symptom from react-dom/scheduler
    // frames only) so genuine unhandled errors keep failing CI.
    onUnhandledError(error) {
      const stack = 'stack' in error && typeof error.stack === 'string' ? error.stack : ''
      if (
        error.name === 'ReferenceError' &&
        error.message.includes('window is not defined') &&
        /react-dom|scheduler/.test(stack)
      ) {
        console.warn(
          '[vitest.config] filtered post-teardown React scheduler error (see vitest.setup.ts drain):',
          error.message,
        )
        return false
      }
    },
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
