import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ORACLE_ABI } from '@kamiazya/whiteboard-core-wasm'
import { installMarkdownModel } from './src/test-utils/markdown-model.js'

/**
 * Installs the Rust core's markdown parse as this realm's reader of what a
 * markdown text means, from the ORACLE artifact (`pnpm rust:build:wasm:oracle`:
 * the shipped build plus `oracle-surface`'s test exports, which carry the
 * parse). Outside `src/` because it reads the artifact with `node:*`, which
 * the browser app's source may not import (`web-app-boundary.test.ts`).
 * A missing or shipped-only artifact fails the file naming the build step.
 */
const dir = process.env.WHITEBOARD_WASM_DIR ?? ''
const glue = join(dir, 'whiteboard_wasm.js')
const build = 'run `pnpm rust:build:wasm:oracle`'

let module: {
  initSync(input: { module: BufferSource }): unknown
  abi_version(): string
  markdown_model(text: string, aliases: string): string
}
try {
  module = await import(/* @vite-ignore */ pathToFileURL(glue).href)
  module.initSync({ module: readFileSync(join(dir, 'whiteboard_wasm_bg.wasm')) })
} catch (cause) {
  throw new Error(`no oracle wasm artifact at ${glue}; ${build}`, { cause })
}
if (module.abi_version() !== ORACLE_ABI) {
  throw new Error(
    `the wasm artifact speaks ABI ${module.abi_version()}, these tests ${ORACLE_ABI}; ${build}`,
  )
}
if (typeof module.markdown_model !== 'function') {
  throw new Error(`the oracle artifact lacks markdown_model; ${build}`)
}
installMarkdownModel(module.markdown_model)
