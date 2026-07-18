import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'canvas-viewer-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
