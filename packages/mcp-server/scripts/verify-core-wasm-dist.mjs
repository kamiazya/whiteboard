#!/usr/bin/env node
// prepack gate: fails the pack/publish when the Rust core's wasm artifact was
// never copied into dist/ (see copy-core-wasm-into-dist.mjs). The copy step
// tolerates an unbuilt artifact so a local build works; this is where a
// release learns it shipped none.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE_WASM_DIR_SEGMENTS, CORE_WASM_FILES } from './copy-core-wasm-into-dist.mjs'
import { runPrepackGate } from './prepack-gate-lib.mjs'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function findMissingCoreWasm(packageRoot = PACKAGE_ROOT) {
  for (const file of CORE_WASM_FILES) {
    const path = resolve(packageRoot, 'dist', ...CORE_WASM_DIR_SEGMENTS, file)
    if (!existsSync(path)) return path
  }
  return null
}

runPrepackGate(import.meta.url, {
  find: findMissingCoreWasm,
  remedy:
    'run `pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm` (and `cargo xtask notices`, then `stage:wasm`), then `pnpm build`, before packing.',
  present: 'dist/assets/core-wasm present',
})
