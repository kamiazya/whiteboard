import { type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { LayoutCore } from '../../layout/edges/layout-core.js'
import { requireWasm, wasmBytes } from './glue.js'

let loaded: LayoutCore | undefined

/**
 * The core built from THIS commit's Rust (`pnpm rust:build:wasm:oracle`), as
 * every entry of a layout: what the scoreboards judge in canvas-render-rust,
 * the job a Rust change selects. A run without the artifact fails here,
 * naming the build step, rather than scoring nothing.
 */
export function oracleLayoutCore(): LayoutCore {
  if (loaded === undefined) {
    const core = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
    loaded = { routing: core, layout: core, markdown: core, query: core }
  }
  return loaded
}
