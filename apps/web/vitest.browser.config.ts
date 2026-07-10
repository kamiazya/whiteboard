import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'
import { defineConfig } from 'vitest/config'
import { resolveBrowserLaunchOptions } from '../../packages/mcp-server/src/server/browser-test-config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Matches vitest.config.ts and tsconfig's '@/*' path — needed once any
      // browser-tested component pulls in a components/ui/* file (they all
      // import '@/lib/utils' for the cn() helper).
      '@': resolve(__dirname, 'src'),
      // Resolve browser-shared from source so tests run before `pnpm build`.
      '@kamiazya/whiteboard-mcp/browser-shared': resolve(
        __dirname,
        '../../packages/mcp-server/src/shared/browser-shared-index.ts',
      ),
      '@kamiazya/whiteboard-mcp/migration-bundle': resolve(
        __dirname,
        '../../packages/mcp-server/src/shared/migration-bundle.ts',
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
  // tailwindcss: layout browser tests import src/index.css to assert real
  // computed geometry (e.g. the Excalidraw container filling the viewport).
  plugins: [tailwindcss(), react(), wasm(), topLevelAwait()],
  // Vitest browser mode serves test dependencies from the Vite dev server on
  // demand instead of bundling them ahead of time. Under CI load, the lazy
  // dependency-optimization scan can race with the browser's first fetch of
  // one of these modules, producing a spurious "Failed to fetch dynamically
  // imported module" import error unrelated to the test itself. Listing the
  // packages every browser test transitively imports forces them into the
  // pre-bundle before any test file runs, removing the race at the source.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react-router-dom',
      '@testing-library/react',
    ],
  },
  test: {
    name: 'web-browser',
    include: ['src/**/*.browser.test.tsx'],
    browser: {
      enabled: true,
      headless: true,
      connectTimeout: 120_000,
      screenshotFailures: false,
      trace: {
        mode: 'retain-on-failure',
        tracesDir: './tmp/vitest-traces',
        screenshots: true,
        snapshots: true,
      },
      viewport: { width: 1280, height: 900 },
      provider: playwright({
        launchOptions: resolveBrowserLaunchOptions(process.env),
      }),
      instances: [{ browser: 'chromium' }],
    },
  },
})
