import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'canvas-model-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
