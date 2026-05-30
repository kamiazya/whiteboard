import { defineProject, mergeConfig } from 'vitest/config'
import sharedConfig from './vitest.shared.js'

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: 'mcp-jsdom',
      include: ['src/app/**/*.test.ts', 'src/app/**/*.test.tsx'],
      exclude: [
        'src/app/**/*.browser.test.tsx',
        // *.docs-snapshot.test.tsx files run only via `pnpm docs:snapshots`
        // — they need a real browser + Playwright to invoke page.screenshot()
        // and would error out under jsdom.
        'src/app/**/*.docs-snapshot.test.tsx',
      ],
      environment: 'jsdom',
    },
  }),
)
