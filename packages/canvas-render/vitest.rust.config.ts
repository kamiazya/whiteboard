import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

// The TypeScript-against-wasm differential (ADR-0054, QR-21 layer 2). It
// needs the artifact `pnpm rust:build:wasm` writes, so CI runs it in the
// `rust` job after that build and nowhere else; the stress lane leaves its
// files out for the same reason. The directory reaches the tests through the
// environment so no test counts its way up to the repository root.
export default defineProject({
  test: {
    name: 'canvas-render-rust',
    environment: 'node',
    include: ['src/**/*.rust.test.ts'],
    env: {
      WHITEBOARD_WASM_DIR: resolve(here, '../../target/dist/wasm-bindgen/whiteboard-wasm'),
    },
  },
})
