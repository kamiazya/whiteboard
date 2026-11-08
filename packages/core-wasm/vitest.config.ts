import { defineConfig } from 'vitest/config'

// A bare `vitest run` goes through this aggregate, as in the other packages.
// core-wasm-rust needs the staged artifact, so CI runs it in the `rust` job.
export default defineConfig({
  test: {
    projects: ['./vitest.node.config.ts'],
  },
})
