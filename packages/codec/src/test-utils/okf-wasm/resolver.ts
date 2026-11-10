import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const okfDir = resolve(here, '../../okf')

/**
 * Layer 1 of QR-21: codec's own OKF suites, unchanged, with `./parse.js` and
 * `./serialize.js` answered by the Rust core (`src/test-utils/okf-wasm/`).
 * Scoped to importers in `src/okf/`, since `spatial/` has modules by the same
 * names, and never for the importers that need the TypeScript itself:
 * `okf-core.ts`, the switch whose `ts` side it is, and the live differentials,
 * whose oracle it is.
 */
export function okfWasmShims() {
  const keepTypeScript = new Set([
    'okf-core.ts',
    'wasm.rust.test.ts',
    'serialize-unsafe.rust.test.ts',
  ])
  const shims: Record<string, string> = {
    './parse.js': resolve(here, 'parse.ts'),
    './serialize.js': resolve(here, 'serialize.ts'),
  }
  return {
    name: 'okf-wasm-shims',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
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
