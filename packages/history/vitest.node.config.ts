import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'history-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
