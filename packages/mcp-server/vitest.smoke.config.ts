import { defineProject, mergeConfig } from 'vitest/config'
import sharedConfig from './vitest.shared.js'

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: 'mcp-smoke',
      include: ['src/**/*.smoke.test.ts'],
      environment: 'node',
      testTimeout: 60_000,
      hookTimeout: 60_000,
      maxWorkers: 1,
    },
  }),
)
