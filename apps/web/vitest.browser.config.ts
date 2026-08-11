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
  // tailwindcss: layout browser tests import src/index.css to assert real
  // computed geometry (e.g. the canvas viewer container filling the viewport).
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
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      'react-router-dom',
      '@testing-library/react',
    ],
  },
  test: {
    name: 'web-browser',
    include: ['src/**/*.browser.test.tsx'],
    // Browser mode's 15s default is a real ceiling here, not a safety net: a
    // test that mounts a page, drives Radix through a portal and waits on
    // IndexedDB spends most of its budget on machine time, and vitest runs
    // these files in PARALLEL. On a loaded machine that tips whole files over
    // at once — the observed failures are `Test timed out`, not assertion
    // failures, and the same tests pass 4/4 when their file runs alone.
    //
    // A timeout costs nothing while tests pass; it only decides how long a
    // genuinely hung test takes to report. 30s matches the precedent already
    // set by vitest.docs-snapshots.config.ts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every browser test renders against the app's real stylesheet — see
    // browser-setup.ts for what silently breaks without it.
    setupFiles: ['./src/test-utils/browser-setup.ts'],
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
