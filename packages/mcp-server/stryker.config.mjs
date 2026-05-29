/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.stryker.config.ts',
  },
  mutate: [
    'src/shared/diagnostics/redact.ts',
    'src/server/store/path-guard.ts',
    'src/server/output-path.ts',
    'src/shared/api-contracts/libraries.ts',
    'src/shared/api-contracts/daemon-doctor.ts',
    'src/shared/api-contracts/runtime.ts',
    'src/server/security/server-mode-env-config.ts',
    'src/server/security/server-mode-auth-plan.ts',
    'src/server/security/server-mode-exposure.ts',
    'src/server/security/server-mode-record.ts',
    'src/server/routes/canvas-thumbnail.ts',
    'src/server/routes/canvas-output-path-error.ts',
  ],
  reporters: ['progress', 'clear-text', 'html'],
  htmlReporter: {
    fileName: 'tmp/stryker-reports/mutation.html',
  },
  tempDirName: 'tmp/stryker-sandbox',
}
