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
      // Stryker runs this package's own `vitest`, whose peer set differs from
      // the one `@fast-check/vitest` binds to through `model`'s test-utils. Left
      // external, the two are different instances and every property test
      // fails to load ("failed to find the current suite") — measured as 31 of
      // 33 fast-check files. Inlining it resolves `vitest` through this
      // project, so there is one.
      server: { deps: { inline: ['@fast-check/vitest'] } },
      // Pins the property seed: Stryker re-selects tests by title, and the
      // seed is in it. See `vitest.stryker-setup.ts`.
      setupFiles: ['./vitest.stryker-setup.ts'],
      testTimeout: 10_000,
      hookTimeout: 10_000,
    },
  }),
)
