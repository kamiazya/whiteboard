import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'codec-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Reads the artifact `pnpm rust:build:wasm` writes; the `rust` job runs it as codec-rust.
    exclude: ['src/**/*.rust.test.ts'],
  },
})
