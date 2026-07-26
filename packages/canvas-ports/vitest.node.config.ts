import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'canvas-ports-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
