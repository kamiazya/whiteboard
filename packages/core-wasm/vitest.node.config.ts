import { defineProject } from 'vitest/config'

// The shim over a fake glue: encoding, decoding, the ABI refusal. Needs no
// artifact, so it runs wherever the TypeScript does.
export default defineProject({
  test: {
    name: 'core-wasm-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.rust.test.ts'],
  },
})
