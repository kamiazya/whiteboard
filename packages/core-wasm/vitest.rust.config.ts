import { resolve } from 'node:path'
import { defineProject } from 'vitest/config'

// The shim over the real artifact `stage:wasm` copies into artifacts/. CI
// runs it in the `rust` job after the wasm build, and fails there when the
// artifact is absent.
export default defineProject({
  test: {
    name: 'core-wasm-rust',
    environment: 'node',
    include: ['src/**/*.rust.test.ts'],
    // The oracle build, for the tests that need an export the shipped one
    // leaves out (the deliberate trap); the rest load the staged artifact.
    env: {
      WHITEBOARD_WASM_DIR: resolve(
        import.meta.dirname,
        '../../target/dist-oracle/wasm-bindgen/whiteboard-wasm',
      ),
    },
  },
})
