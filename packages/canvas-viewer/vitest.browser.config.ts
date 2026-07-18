import { playwright } from '@vitest/browser-playwright'
import react from '@vitejs/plugin-react'
import { defineProject } from 'vitest/config'
import { resolveBrowserLaunchOptions } from '@kamiazya/whiteboard-mcp/test-utils'

export default defineProject({
  plugins: [react()],
  test: {
    name: 'canvas-viewer-browser',
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
      viewport: { width: 800, height: 600 },
      provider: playwright({
        launchOptions: resolveBrowserLaunchOptions(process.env),
      }),
      instances: [{ browser: 'chromium' }],
    },
  },
})
