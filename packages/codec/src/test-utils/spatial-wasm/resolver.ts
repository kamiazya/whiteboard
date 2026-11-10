import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const spatialDir = resolve(here, '../../spatial')

/**
 * Layer 1 of QR-21 for JSON Canvas: codec's own spatial suites, unchanged,
 * with `./parse.js` and `./serialize.js` answered by the Rust core
 * (`src/test-utils/spatial-wasm/`). Scoped to importers in `src/spatial/`,
 * since `okf/` has modules by the same names, and never for the live
 * differential, whose oracle is the TypeScript.
 */
export function spatialWasmShims() {
  const keepTypeScript = new Set(['wasm.rust.test.ts'])
  const shims: Record<string, string> = {
    './parse.js': resolve(here, 'parse.ts'),
    './serialize.js': resolve(here, 'serialize.ts'),
  }
  return {
    name: 'spatial-wasm-shims',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      const shim = shims[source]
      if (shim === undefined || importer === undefined) return undefined
      const file = importer.split('?')[0] as string
      if (dirname(file) !== spatialDir || keepTypeScript.has(file.slice(spatialDir.length + 1))) {
        return undefined
      }
      return shim
    },
  }
}
