import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'codec-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
