import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'loro-adapter-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
