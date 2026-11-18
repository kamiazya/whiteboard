import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'search-node',
    environment: 'node',
    // Installs the Rust core, which this package's functions answer through (its core-setup); a
    // missing artifact fails the project by name.
    setupFiles: ['./src/test-utils/core-setup/node.setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})
