/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  plugins: ['@stryker-mutator/vitest-runner'],
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
    'src/server/security/server-mode-auth-plan.ts',
    'src/server/security/server-mode-exposure.ts',
    'src/server/security/server-mode-record.ts',
  ],
  reporters: ['progress', 'clear-text', 'html'],
  htmlReporter: {
    fileName: 'tmp/stryker-reports/mutation.html',
  },
  tempDirName: 'tmp/stryker-sandbox',
}
