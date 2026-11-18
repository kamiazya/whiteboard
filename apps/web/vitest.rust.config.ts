import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

// The tests that need the Rust core's markdown parse, the one parser left now
// the TypeScript one is gone: it answers what a text means, which the editor's
// property tests hold the editor's own reading to. The parse is an
// `oracle-surface` export, so these run in the `rust` job after
// `pnpm rust:build:wasm:oracle` and nowhere else, and a run without the
// artifact fails naming that step. They are the `*.rust.test.ts` files.
export default defineProject({
  test: {
    name: 'web-rust',
    environment: 'node',
    setupFiles: ['./vitest.markdown-model.setup.ts'],
    include: ['src/**/*.rust.test.ts'],
    testTimeout: 20_000,
    env: {
      WHITEBOARD_WASM_DIR: resolve(here, '../../target/dist-oracle/wasm-bindgen/whiteboard-wasm'),
    },
  },
})
