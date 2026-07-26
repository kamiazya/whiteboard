import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'canvas-workspace-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
