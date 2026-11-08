import { defineProject } from 'vitest/config'

// The shim over the real artifact `stage:wasm` copies into artifacts/. CI
// runs it in the `rust` job after the wasm build, and fails there when the
// artifact is absent.
export default defineProject({
  test: {
    name: 'core-wasm-rust',
    environment: 'node',
    include: ['src/**/*.rust.test.ts'],
  },
})
