import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The wasm artifact `pnpm rust:build:wasm` writes, loaded once for the
 * canvas-render-rust project (ADR-0054, QR-21). Its directory arrives through
 * `WHITEBOARD_WASM_DIR`, set by vitest.rust.config.ts, so nothing here counts
 * its way up to the repository root.
 */

/** What the tests read of the wasm-bindgen glue, declared rather than imported: the glue is a build output. */
export interface WasmGlue {
  initSync(input: { module: BufferSource }): unknown
  abi_version(): string
  det_hypot(dx: Float64Array, dy: Float64Array): Float64Array
  det_sin(xs: Float64Array): Float64Array
  det_cos(xs: Float64Array): Float64Array
  edge_route_on_grid(input: Float64Array): Float64Array
  det_round(xs: Float64Array): Float64Array
  edge_segment_tests(cases: Float64Array): Float64Array
  edge_path_measures(input: Float64Array): Float64Array
}

/** The surface these tests were written against; a stale artifact fails on this, not on its first mismatched call. */
export const EXPECTED_ABI = '4'

const dir = process.env.WHITEBOARD_WASM_DIR ?? ''

/** Where the glue is looked for, for a message that says what is missing. */
export const gluePath = join(dir, 'whiteboard_wasm.js')

/** Whether the artifact is there. A probe, read once. */
export const built = dir !== '' && existsSync(gluePath)

/** The initialised glue, or undefined when the artifact is absent. */
export const wasm: WasmGlue | undefined = built
  ? await (async () => {
      const glue = (await import(pathToFileURL(gluePath).href)) as WasmGlue
      glue.initSync({ module: readFileSync(join(dir, 'whiteboard_wasm_bg.wasm')) })
      return glue
    })()
  : undefined

// Checked once: the shim calls requireWasm per grid query, and a String
// export per call would be boundary cost the spike's timings then charge to
// the routing export.
let abiChecked = false

/** The glue, failing loudly for a caller that only runs when it is built. */
export function requireWasm(): WasmGlue {
  if (wasm === undefined)
    throw new Error(`no wasm artifact at ${gluePath}; run \`pnpm rust:build:wasm\``)
  if (!abiChecked) {
    const abi = wasm.abi_version()
    if (abi !== EXPECTED_ABI)
      throw new Error(
        `the wasm artifact speaks ABI ${abi}, these tests ${EXPECTED_ABI}; rebuild it`,
      )
    abiChecked = true
  }
  return wasm
}
