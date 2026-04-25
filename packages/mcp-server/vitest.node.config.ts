import { defineProject, mergeConfig } from 'vitest/config'
import sharedConfig from './vitest.shared.js'

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: 'mcp-node',
      include: [
        'src/daemon/**/*.test.ts',
        'src/server/**/*.test.ts',
        'src/shared/**/*.test.ts',
      ],
      environment: 'node',
    },
  }),
)
