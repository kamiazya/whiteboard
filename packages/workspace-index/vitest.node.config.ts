import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'workspace-index-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
