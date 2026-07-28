import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'server-core-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
