import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))
const wasmDir = resolve(here, '../../target/dist/wasm-bindgen/whiteboard-wasm')

// The TypeScript-against-wasm differential (ADR-0054, QR-21). It needs the
// artifact `pnpm rust:build:wasm` writes, so CI runs it in the `rust` job
// after that build and nowhere else.
//
// Two layers run here:
// - layer 2, `*.rust.test.ts`: properties holding a TypeScript function to its
//   Rust twin, always included, failing on CI when the artifact is absent;
// - layer 1, the EXISTING layout/edges suites with the grid router, the
//   edge router and the side-choice search swapped for their Rust ports
//   (`./grid-route.js`, `./edge-router.js` and `./spatial-edges.js` aliased
//   to wasm-backed shims), so its
//   examples, the optimality property and the routing scoreboard judge the
//   Rust router unchanged. They are included only when the artifact is there,
//   because a run without it — the stress lane, a fresh checkout — would
//   otherwise run them against nothing.
const ported = existsSync(resolve(wasmDir, 'whiteboard_wasm.js'))

export default defineProject({
  resolve: {
    alias: [
      {
        find: /^\.\/grid-route\.js$/,
        replacement: resolve(here, 'src/test-utils/wasm/grid-route.ts'),
      },
      {
        find: /^\.\/edge-router\.js$/,
        replacement: resolve(here, 'src/test-utils/wasm/edge-router.ts'),
      },
      {
        find: /^\.\/(edges\/)?spatial-edges\.js$/,
        replacement: resolve(here, 'src/test-utils/wasm/spatial-edges.ts'),
      },
    ],
  },
  test: {
    name: 'canvas-render-rust',
    environment: 'node',
    include: ['src/**/*.rust.test.ts', ...(ported ? ['src/layout/edges/**/*.test.ts'] : [])],
    // grid-route.cost.test.ts counts the obstacle READS the TypeScript search
    // makes; the shim reads each rect once per call, so under Rust its bound
    // cannot fail and it would judge nothing. spatial-edges.cost.test.ts counts
    // the side-choice search's work through mocks of its TypeScript modules,
    // which the Rust search never calls; the budget accounts that bound the
    // Rust search are compared exactly by spatial-edges.rust.test.ts.
    exclude: [
      'src/**/*.browser.test.ts',
      'src/layout/edges/grid-route.cost.test.ts',
      'src/layout/edges/spatial-edges.cost.test.ts',
    ],
    testTimeout: 20_000,
    // `vitest bench --project "canvas-render-rust (bench)"`: the spike's
    // TypeScript-against-Rust measurement.
    benchmark: { include: ['src/**/*.rust.bench.ts'] },
    env: { WHITEBOARD_WASM_DIR: wasmDir },
  },
})
