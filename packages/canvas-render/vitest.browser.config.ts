import { playwright } from '@vitest/browser-playwright'
import { defineProject } from 'vitest/config'
// Import the source file directly rather than `@kamiazya/whiteboard-mcp/test-utils`:
// that package export resolves to the built `dist/` output, which is gitignored
// and not produced by a plain `pnpm install` on a clean checkout (CI's browser
// job never builds packages/mcp-server before running Vitest).
import { resolveBrowserLaunchOptions } from '../mcp-server/src/server/browser-test-config.js'

export default defineProject({
  test: {
    name: 'canvas-render-browser',
    include: ['src/**/*.browser.test.ts'],
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
      viewport: { width: 800, height: 600 },
      provider: playwright({
        launchOptions: resolveBrowserLaunchOptions(process.env),
      }),
      instances: [{ browser: 'chromium' }],
    },
  },
})
