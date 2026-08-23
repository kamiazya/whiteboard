import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'search-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
