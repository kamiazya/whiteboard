import { defineProject, mergeConfig } from 'vitest/config'
import { coveringTests } from './scripts/mutation/covering-tests.mjs'
import sharedConfig from './vitest.shared.js'

// Stryker-only vitest config — covers pure unit/integration tests that run in node.
// Smoke and distribution tests require a running daemon or packaged binary and must
// not be included here; they are also incompatible with Stryker's sandbox isolation.
// Never use this config for normal test runs or CI — use vitest.node.config.ts instead.
//
// Only the tests near a mutated module are included: the initial run executes
// every included test once with coverage on, and Stryker abandons the lane when
// that run outlasts `dryRunTimeoutMinutes` or any test in it fails. The set is
// derived from the import graph (`scripts/mutation/covering-tests.mjs`, which
// says how near) so a test that starts importing a mutated module joins the
// lane by itself.
export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: 'mcp-node',
      include: coveringTests(),
      exclude: [
        // Smoke and distribution tests require a live daemon or packaged binary.
        '**/*.smoke.test.ts',
        '**/*.distribution.test.ts',
        // vi.spyOn(process.stderr, 'write') conflicts with Stryker worker isolation;
        // the stderr non-leak contract is covered by the regular mcp-node suite.
        '**/cli/dispatcher-server-run.test.ts',
        // Stryker runs the tests on a threads pool, where `process.chdir()` is
        // unsupported; these change into a directory holding a config file.
        '**/cli/dispatcher-config-file.test.ts',
        '**/cli/dispatcher-daemon-run-auto-open.test.ts',
        // They measure how long the event loop is blocked, which a mutant
        // cannot change and a loaded box does: any failure ends the initial run.
        '**/*-loop-availability.test.ts',
        // Reads sibling packages and the repo root, which Stryker's sandbox,
        // a copy of this package alone, does not hold; it guards the published
        // package shape, not a mutated module.
        '**/release/package-shape.test.ts',
      ],
      environment: 'node',
      // Pins the property seed: Stryker re-selects tests by title, and the
      // seed is in it. See `vitest.stryker-setup.ts`.
      setupFiles: ['./vitest.stryker-setup.ts'],
      testTimeout: 10_000,
      hookTimeout: 10_000,
    },
  }),
)
