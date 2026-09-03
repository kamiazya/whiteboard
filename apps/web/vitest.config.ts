import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'
import { defineConfig } from 'vitest/config'
import { mcpSourceAlias } from './mcp-source-alias.js'
import { rendererBuildDefine } from './renderer-build-id.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  define: { ...rendererBuildDefine },
  plugins: [react(), svgr(), wasm(), topLevelAwait()],
  resolve: {
    alias: {
      ...mcpSourceAlias,
      '@': resolve(__dirname, 'src'),
      // Also test-only: the SseStreamSource behavioural contract, declared once
      // in the package that owns the port and run here against the
      // SharedWorker-backed implementation this app ships.
      '@kamiazya/whiteboard-mcp/sse-stream-source-contract': resolve(
        __dirname,
        '../../packages/mcp-server/src/shared/test-utils/sse-stream-source-contract.ts',
      ),
      '@kamiazya/whiteboard-mcp/document-backend-contract-suite': resolve(
        __dirname,
        '../../packages/mcp-server/src/shared/test-utils/document-backend-contract.ts',
      ),
      // Subpath aliases must precede the root alias: rollup-alias prefix-matches,
      // so the root entry alone would rewrite '/scene' to 'index.ts/scene'.
      '@kamiazya/whiteboard-canvas-viewer/scene': resolve(
        __dirname,
        '../../packages/canvas-viewer/src/scene.ts',
      ),
      // boot.ts (main.tsx's boot chain) imports this narrow subpath so a
      // jsdom test of the boot sequence does not need the whole viewer graph.
      '@kamiazya/whiteboard-canvas-viewer/font-loading': resolve(
        __dirname,
        '../../packages/canvas-viewer/src/font-loading.ts',
      ),
      // Resolve canvas-viewer from source so tests run before `pnpm build`.
      '@kamiazya/whiteboard-canvas-viewer': resolve(
        __dirname,
        '../../packages/canvas-viewer/src/index.ts',
      ),
    },
  },
  test: {
    name: 'web-jsdom',
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
