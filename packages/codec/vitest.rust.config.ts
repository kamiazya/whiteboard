import { defineProject } from 'vitest/config'
import { spatialWasmShims } from './src/test-utils/spatial-wasm/resolver.js'
import { SPATIAL_SUITES } from './src/test-utils/spatial-wasm/suites.js'

// The JSON Canvas codec held to its Rust twin through the staged wasm artifact
// (ADR-0054, QR-21). CI runs it in the `rust` job after the wasm build and
// `stage:wasm`, and fails there when the artifact is absent.
// - layer 2, `*.rust.test.ts`: the live differential against the TypeScript;
// - layer 1 for JSON Canvas, the spatial suites that reach `parseSpatial` or
//   `serializeSpatial` (`src/test-utils/spatial-wasm/suites.ts`), run against the
//   Rust core with its decline answered by the TypeScript. No test is excused a
//   decline, and `setup.ts` fails one. The one test that replaces a module
//   inside the TypeScript's own serialiser runs on the TypeScript
//   (`src/test-utils/spatial-wasm/typescript-only.ts`).
// The OKF envelope has no TypeScript to be held against: codec-node runs its
// suites on the core (`src/test-utils/okf-core-setup/`).
export default defineProject({
  plugins: [spatialWasmShims()],
  test: {
    name: 'codec-rust',
    environment: 'node',
    include: ['src/**/*.rust.test.ts', ...SPATIAL_SUITES],
    setupFiles: ['./src/test-utils/spatial-wasm/setup.ts'],
    // The slowest test (the generated-text property) took 830-870ms over
    // four local runs; the ceiling leaves room for a loaded CI runner, and
    // a test that needs it is a regression worth a failure.
    testTimeout: 30_000,
  },
})
