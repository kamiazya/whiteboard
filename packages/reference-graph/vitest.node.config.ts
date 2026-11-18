import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'reference-graph-node',
    environment: 'node',
    // Installs the Rust OKF core, which this realm's parseOkf/serializeOkf answer through
    // (codec's core-setup), and its search, which extraction and the excerpts answer through
    // (search's); a missing artifact fails the project by name.
    setupFiles: [
      '../../packages/codec/src/test-utils/core-setup/node.setup.ts',
      '../../packages/search/src/test-utils/core-setup/node.setup.ts',
    ],
    include: ['src/**/*.test.ts'],
  },
})
