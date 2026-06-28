import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Resolve browser-shared from source so tests run before `pnpm build`.
      '@kamiazya/whiteboard-mcp/browser-shared': resolve(
        __dirname,
        '../../packages/mcp-server/src/shared/browser-shared-index.ts',
      ),
    },
  },
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    {
      name: 'no-dep-optimizer',
      configResolved(config) {
        // Vite 8's Rolldown-based dep optimizer hangs indefinitely in the Playwright
        // container when the pnpm store cache is cold (lockfile change → cache miss →
        // fresh copies instead of hardlinks). React 19 ships as ESM and doesn't need
        // CJS-to-ESM pre-bundling, so disabling optimization is safe for browser tests.
        config.optimizeDeps.include = []
        config.optimizeDeps.noDiscovery = true
      },
    },
  ],
  test: {
    name: 'web-browser',
    include: ['src/**/*.browser.test.tsx'],
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      trace: {
        mode: 'retain-on-failure',
        tracesDir: './tmp/vitest-traces',
        screenshots: true,
        snapshots: true,
      },
      viewport: { width: 1280, height: 900 },
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
})
