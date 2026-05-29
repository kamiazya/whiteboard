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
        'src/cli/**/*.test.ts',
      ],
      exclude: ['src/**/*.smoke.test.ts', 'src/**/*.distribution.test.ts'],
      environment: 'node',
      // Several mcp-node tests stand up a full createApp + MCP client + JSON-RPC
      // roundtrip in one case, which on slower CI runners flirts with vitest's
      // 5s default. 10s leaves slack for cold-start migrations + handler dispatch
      // without masking real hangs.
      testTimeout: 10_000,
      hookTimeout: 10_000,
    },
  }),
)
