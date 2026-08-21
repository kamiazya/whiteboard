import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'facet-engine-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
