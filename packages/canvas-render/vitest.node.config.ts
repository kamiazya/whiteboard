import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'canvas-render-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
