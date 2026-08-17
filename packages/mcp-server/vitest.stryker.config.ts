import { defineProject, mergeConfig } from 'vitest/config'
import sharedConfig from './vitest.shared.js'

// Stryker-only vitest config — covers pure unit/integration tests that run in node.
// Smoke and distribution tests require a running daemon or packaged binary and must
// not be included here; they are also incompatible with Stryker's sandbox isolation.
// Never use this config for normal test runs or CI — use vitest.node.config.ts instead.
export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: 'mcp-node',
      include: [
        'src/cli/**/*.test.ts',
        'src/daemon/**/*.test.ts',
        'src/server/**/*.test.ts',
        'src/shared/**/*.test.ts',
        '../../tests/e2e/**/fixtures/**/*.test.ts',
      ],
      exclude: [
        // Smoke and distribution tests require a live daemon or packaged binary.
        '**/*.smoke.test.ts',
        '**/*.distribution.test.ts',
        // vi.spyOn(process.stderr, 'write') conflicts with Stryker worker isolation;
        // the stderr non-leak contract is covered by the regular mcp-node suite.
        '**/cli/dispatcher-server-run.test.ts',
      ],
      environment: 'node',
      testTimeout: 10_000,
      hookTimeout: 10_000,
    },
  }),
)
