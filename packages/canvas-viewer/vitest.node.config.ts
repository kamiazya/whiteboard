import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'canvas-viewer-node',
    environment: 'node',
    setupFiles: ['../codec/src/test-utils/core-setup/node.setup.ts'],
    include: ['src/**/*.test.ts'],
    // A browser test must not run in the node environment just because its
    // extension matches — it belongs to canvas-viewer-browser.
    exclude: ['src/**/*.browser.test.ts'],
  },
})
