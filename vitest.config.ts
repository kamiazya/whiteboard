import { defineConfig } from 'vitest/config'
import webJsdom from './apps/web/vitest.config.ts'
// The project list is data in its own file so every guard and CI script that
// needs it parses the same JSON this config imports, instead of reading this
// file as text.
import projects from './vitest.projects.json' with { type: 'json' }

export default defineConfig({
  test: {
    // Runs once per invocation, for every project, and prints a banner when the
    // Node major is not the one in .node-version. It never fails the run: the
    // wrong-major symptoms name neither Node nor the pin, and a scoped run does
    // not reach the guard that does.
    globalSetup: ['./.claude/scripts/node-version-banner.mjs'],
    // Read from the ROOT config only, so the web jsdom project filter is
    // carried up here or a run of that project through this config (a
    // project filter, the coverage lane) drops it. Narrow by construction:
    // it matches one post-teardown React scheduler error and nothing else.
    onUnhandledError: webJsdom.test?.onUnhandledError,
    // Coverage is configured ONLY here: with `projects` the runner reads it
    // from the root config, and a per-project coverage block is ignored. The
    // consumer is the SonarQube lane (.github/workflows/sonarqube.yml), which
    // reads tmp/coverage/lcov.info.
    //
    // A trap, measured and written up in docs/contributing/testing.md: the
    // include globs below are resolved against each project's own root (a
    // repo-prefixed glob matches nothing and writes an empty lcov with no
    // error).
    coverage: {
      provider: 'v8',
      // Default is false, which means a run with ONE failing test writes no
      // report at all — it cleans reportsDirectory and leaves nothing behind.
      // Measured: a full run with 1 of 13032 tests failing produced no
      // lcov.info and no directory, and the lane that consumes it would have
      // uploaded an analysis reporting zero coverage with nothing to say why.
      reportOnFailure: true,
      // lcov only. A text table over 20+ projects is noise in a log nobody
      // opens, and the html report is a local-debugging choice, not a CI one.
      reporter: ['lcov'],
      reportsDirectory: './tmp/coverage',
      include: ['**/src/**/*.{ts,tsx,mjs}'],
      exclude: [
        '**/*.test.*',
        '**/*.bench.*',
        '**/dist/**',
        // A type declaration has no executable line, and Sonar cannot resolve
        // one from an lcov record because sonar.exclusions drops it — measured
        // as `Could not resolve 2 file paths`, both .d.ts.
        '**/*.d.ts',
        // Third-party source this repo carries rather than depends on
        // (architecture-map.md explains why BudouX is vendored); its coverage
        // is not for this project to answer for.
        '**/src/vendor/**',
      ],
    },
    projects,
  },
})
