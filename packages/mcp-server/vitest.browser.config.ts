import { defineProject, mergeConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import sharedConfig from './vitest.shared.js'
import { resolveBrowserLaunchOptions } from './src/server/browser-test-config.js'

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: 'mcp-browser',
      include: ['src/app/**/*.browser.test.tsx'],
      css: true,
      api: {
        host: '127.0.0.1',
      },
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
        viewport: {
          width: 1280,
          height: 900,
        },
        provider: playwright({
          launchOptions: resolveBrowserLaunchOptions(process.env),
        }),
        instances: [{ browser: 'chromium' }],
      },
    },
  }),
)
