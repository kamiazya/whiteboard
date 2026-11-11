import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'server-core-node',
    environment: 'node',
    // Installs the Rust core, which this realm's parseOkf/serializeOkf (codec's core-setup) and
    // facet write answer through; a missing artifact fails the project by name.
    setupFiles: [
      '../../packages/codec/src/test-utils/core-setup/node.setup.ts',
      './src/test-utils/core-setup.node.setup.ts',
    ],
    include: ['src/**/*.test.ts'],
  },
})
