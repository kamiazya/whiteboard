import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'crdt-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
