import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))
const wasmDir = resolve(here, '../../target/dist-oracle/wasm-bindgen/whiteboard-wasm')

// The tests that judge the Rust core built from THIS commit (ADR-0054, QR-21).
// They need the ORACLE artifact `pnpm rust:build:wasm:oracle` writes
// (`oracle-surface`: the per-module test exports the shipped artifact leaves
// out), so CI runs them in the `rust` job after that build and nowhere else,
// and a run without it fails naming the build step. They are the
// `*.rust.test.ts` files: the scoreboards over the layout and the routing
// (`src/routing/`, which reach the router through the wasm-backed shims in
// `src/test-utils/wasm/`), and the replays of the frozen recordings. The
// TypeScript they were once held against is deleted (step 7, S18h).

export default defineProject({
  test: {
    name: 'canvas-render-rust',
    environment: 'node',
    include: ['src/**/*.rust.test.ts'],
    exclude: ['src/**/*.browser.test.ts'],
    testTimeout: 20_000,
    // `vitest bench --project "canvas-render-rust (bench)"`: what the
    // commit's core costs (the drag frame).
    benchmark: { include: ['src/**/*.rust.bench.ts'] },
    env: { WHITEBOARD_WASM_DIR: wasmDir },
  },
})
