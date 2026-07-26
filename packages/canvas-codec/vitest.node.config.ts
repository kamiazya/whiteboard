import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'canvas-codec-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
