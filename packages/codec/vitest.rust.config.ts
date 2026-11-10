import { defineProject } from 'vitest/config'
import { okfWasmShims } from './src/test-utils/okf-wasm/resolver.js'
import { spatialWasmShims } from './src/test-utils/spatial-wasm/resolver.js'
import { SPATIAL_SUITES } from './src/test-utils/spatial-wasm/suites.js'

// The OKF envelope held to its Rust twin through the staged wasm artifact
// (ADR-0054, QR-21). CI runs it in the `rust` job after the wasm build and
// `stage:wasm`, and fails there when the artifact is absent.
// - layer 2, `*.rust.test.ts`: the live differential against the TypeScript;
// - layer 1, the OKF suites under `src/okf/`, run against the Rust core.
//   `okf-core.test.ts` tests the switch, whose TypeScript side would then be
//   Rust too, `parse.cost.test.ts` counts the TypeScript reader's own work, and
//   `yaml-safe.test.ts` tests a schema the envelope never calls into the core
//   for; each is excluded for that reason, and `setup.ts` fails a file the core
//   answered nothing for, so a suite that stops reaching it is noticed. The tests whose only assertion reads
//   the words of a refusal at stage `yaml`, the tolerated difference, are
//   skipped by title (`src/test-utils/okf-wasm/tolerated.ts`, applied in `setup.ts`).
// - layer 1 for JSON Canvas, the spatial suites that reach `parseSpatial` or
//   `serializeSpatial` (`src/test-utils/spatial-wasm/suites.ts`), run against the
//   Rust core with its decline answered by the TypeScript. No test is excused a
//   decline, and `setup.ts` fails one. The one test that replaces a module
//   inside the TypeScript's own serialiser runs on the TypeScript
//   (`src/test-utils/spatial-wasm/typescript-only.ts`).
export default defineProject({
  plugins: [okfWasmShims(), spatialWasmShims()],
  test: {
    name: 'codec-rust',
    environment: 'node',
    include: ['src/**/*.rust.test.ts', 'src/okf/*.test.ts', ...SPATIAL_SUITES],
    exclude: [
      'src/okf/okf-core.test.ts',
      'src/okf/parse.cost.test.ts',
      'src/okf/yaml-safe.test.ts',
    ],
    setupFiles: ['./src/test-utils/okf-wasm/setup.ts', './src/test-utils/spatial-wasm/setup.ts'],
    // The slowest test (the generated-text property) took 830-870ms over
    // four local runs; the ceiling leaves room for a loaded CI runner, and
    // a test that needs it is a regression worth a failure.
    testTimeout: 30_000,
  },
})
