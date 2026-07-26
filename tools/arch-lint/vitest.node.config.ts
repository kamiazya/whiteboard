import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'arch-lint-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
