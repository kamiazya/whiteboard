import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'reference-graph-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
