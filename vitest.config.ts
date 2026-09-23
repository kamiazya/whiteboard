import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Coverage is configured ONLY here: with `projects` the runner reads it
    // from the root config, and a per-project coverage block is ignored. The
    // consumer is the SonarQube lane (.github/workflows/sonarqube.yml), which
    // reads tmp/coverage/lcov.info.
    //
    // Two traps, both measured, both written up in docs/contributing/testing.md:
    // the include globs below are resolved against each project OWN root (a
    // repo-prefixed glob matches nothing and writes an empty lcov with no
    // error), and this file is read as TEXT by three guards whose regexes stop
    // at the next quote — so a comment here carries NO apostrophe, no quoted
    // glob, and no runner name, or the project list below is swallowed whole
    // and an unrelated test reports ENOENT on a path made of this paragraph.
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
    projects: [
      'packages/mcp-server/vitest.node.config.ts',
      'packages/mcp-server/vitest.smoke.config.ts',
      'packages/model/vitest.node.config.ts',
      'packages/ports/vitest.node.config.ts',
      'packages/daemon-client/vitest.node.config.ts',
      'packages/facet-engine/vitest.node.config.ts',
      'packages/facet-ui/vitest.jsdom.config.ts',
      'packages/plugin-visual/vitest.node.config.ts',
      'packages/plugin-visual/vitest.jsdom.config.ts',
      'packages/codec/vitest.node.config.ts',
      'tools/arch-lint/vitest.node.config.ts',
      'packages/loro-adapter/vitest.node.config.ts',
      'packages/search/vitest.node.config.ts',
      'packages/reference-graph/vitest.node.config.ts',
      'packages/server-core/vitest.node.config.ts',
      'packages/workspace-index/vitest.node.config.ts',
      'packages/history/vitest.node.config.ts',
      'packages/scene/vitest.node.config.ts',
      'packages/canvas-render/vitest.node.config.ts',
      'packages/canvas-render/vitest.browser.config.ts',
      'packages/canvas-viewer/vitest.node.config.ts',
      'packages/canvas-viewer/vitest.jsdom.config.ts',
      'packages/canvas-viewer/vitest.browser.config.ts',
      'apps/web/vitest.config.ts',
      'apps/web/vitest.node.config.ts',
      'apps/web/vitest.browser.config.ts',
      'apps/web/vitest.browser-window-state.config.ts',
    ],
  },
})
