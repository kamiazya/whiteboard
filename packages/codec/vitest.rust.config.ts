import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineProject } from 'vitest/config'
import { runsUnderRust } from './src/test-utils/okf-wasm/tolerated.js'

const here = dirname(fileURLToPath(import.meta.url))
const okfDir = resolve(here, 'src/okf')

/**
 * Layer 1 of QR-21: codec's own OKF suites, unchanged, with `./parse.js` and
 * `./serialize.js` answered by the Rust core (`src/test-utils/okf-wasm/`).
 * Scoped to importers in `src/okf/`, since `spatial/` has modules by the same
 * names, and never for the two importers that need the TypeScript itself:
 * `okf-core.ts`, the switch whose `ts` side it is, and the live differential,
 * whose oracle it is.
 */
function okfToRust(): Plugin {
  const keepTypeScript = new Set(['okf-core.ts', 'wasm.rust.test.ts'])
  const shims: Record<string, string> = {
    './parse.js': resolve(here, 'src/test-utils/okf-wasm/parse.ts'),
    './serialize.js': resolve(here, 'src/test-utils/okf-wasm/serialize.ts'),
  }
  return {
    name: 'okf-to-rust',
    enforce: 'pre',
    resolveId(source, importer) {
      const shim = shims[source]
      if (shim === undefined || importer === undefined) return undefined
      const file = importer.split('?')[0] as string
      if (dirname(file) !== okfDir || keepTypeScript.has(file.slice(okfDir.length + 1))) {
        return undefined
      }
      return shim
    },
  }
}

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
//   left out by title (`src/test-utils/okf-wasm/tolerated.ts`).
export default defineProject({
  plugins: [okfToRust()],
  test: {
    name: 'codec-rust',
    environment: 'node',
    include: ['src/**/*.rust.test.ts', 'src/okf/*.test.ts'],
    exclude: [
      'src/okf/okf-core.test.ts',
      'src/okf/parse.cost.test.ts',
      'src/okf/yaml-safe.test.ts',
    ],
    testNamePattern: runsUnderRust,
    setupFiles: ['./src/test-utils/okf-wasm/setup.ts'],
    // The slowest test (the generated-text property) took 830-870ms over
    // four local runs; the ceiling leaves room for a loaded CI runner, and
    // a test that needs it is a regression worth a failure.
    testTimeout: 30_000,
  },
})
