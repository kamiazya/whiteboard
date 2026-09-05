import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'daemon-client-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
