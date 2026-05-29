import { defineConfig, mergeConfig } from 'vitest/config'
import sharedConfig from './vitest.shared.js'

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      name: 'mcp-distribution',
      include: ['src/**/*.distribution.test.ts'],
      environment: 'node',
      testTimeout: 120_000,
      hookTimeout: 60_000,
      maxWorkers: 1,
    },
  }),
)
