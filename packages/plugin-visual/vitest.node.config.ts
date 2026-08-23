import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'plugin-visual-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
