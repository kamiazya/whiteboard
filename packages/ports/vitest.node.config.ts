import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'ports-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
