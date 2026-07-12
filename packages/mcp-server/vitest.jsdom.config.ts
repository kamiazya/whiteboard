import { defineProject, mergeConfig } from 'vitest/config'
import sharedConfig from './vitest.shared.js'

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: 'mcp-jsdom',
      include: ['src/app/**/*.test.ts', 'src/app/**/*.test.tsx'],
      exclude: ['src/app/**/*.browser.test.tsx'],
      environment: 'jsdom',
      setupFiles: ['./src/app/test-jsdom-setup.ts'],
    },
  }),
)
