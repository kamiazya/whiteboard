import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'scene-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
