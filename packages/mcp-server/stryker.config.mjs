import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  // Resolved from THIS file rather than named: Stryker loads a bare plugin name
  // from its own location in the pnpm store, where this package's dependency
  // is not resolvable, and the lane then fails with no TestRunner plugin.
  plugins: [require.resolve('@stryker-mutator/vitest-runner')],
  // Stryker's default is 5 minutes, and the initial run is one runner executing
  // every selected test serially, so a loaded box reads as a config error.
  // measured: 2026-10-03 15 min on 4 cores at load 50 (3.6 CPU-minutes)
  dryRunTimeoutMinutes: 30,
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.stryker.config.ts',
  },
  mutate: [
    'src/shared/diagnostics/redact.ts',
    'src/server/app-helpers.ts',
    'src/server/store/path-guard.ts',
    'src/server/output-path.ts',
    'src/shared/api-contracts/daemon-doctor.ts',
    // api-contracts/runtime.ts moved to @kamiazya/whiteboard-daemon-client with
    // its property tests; a mutate entry here reaches only files inside this
    // package, so the slot moves with the file (daemon-client has no stryker
    // lane yet). NOTE: the guard test scans every quoted string in this array
    // block, comments included — no apostrophes here.
    'src/server/security/server-mode-env-config.ts',
    'src/server/security/server-mode-exposure.ts',
    'src/server/security/server-mode-record.ts',
  ],
  reporters: ['progress', 'clear-text', 'html'],
  htmlReporter: {
    fileName: 'tmp/stryker-reports/mutation.html',
  },
  tempDirName: 'tmp/stryker-sandbox',
}
