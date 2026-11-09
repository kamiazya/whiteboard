#!/usr/bin/env node
// Build step: copies the Rust core's wasm artifact into dist so a published
// install resolves it at dist/assets/core-wasm (`packagedArtifacts` in
// src/server/export/layout-core.ts), where a tarball has no sibling
// core-wasm package to find. Runs AFTER tsdown (its clean option would wipe an
// earlier copy), like the other copy steps.
//
// The artifact is built by `pnpm --filter @kamiazya/whiteboard-core-wasm
// build:wasm`, which needs a Rust toolchain. A plain local build without one
// copies nothing and says so; verify-core-wasm-dist.mjs, chained into
// `prepack`, is what refuses to pack or publish without it.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRunAsScript } from '../../../tools/checks/src/is-run-as-script.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
// Also read by verify-core-wasm-dist.mjs (under 'dist'), so the pack gate and
// this copy step cannot drift apart on the paths. The glue instantiates the
// wasm; the notices are the licence text the wasm's linked crates require.
export const CORE_WASM_DIR_SEGMENTS = ['assets', 'core-wasm']
export const CORE_WASM_FILES = [
  'whiteboard_wasm.js',
  'whiteboard_wasm_bg.wasm',
  'THIRD-PARTY-NOTICES',
]
// The two files the daemon cannot load the core without.
const LOADABLE = CORE_WASM_FILES.slice(0, 2)
export const SRC_DIR = resolve(SCRIPT_DIR, '..', '..', 'core-wasm', 'artifacts')
export const DEST_DIR = resolve(SCRIPT_DIR, '..', 'dist', ...CORE_WASM_DIR_SEGMENTS)

/**
 * @returns {{ copied: string[] }} what was copied; empty when nothing was staged
 */
export function copyCoreWasmIntoDist(srcDir = SRC_DIR, destDir = DEST_DIR) {
  const present = LOADABLE.filter((file) => existsSync(resolve(srcDir, file)))
  if (present.length === 0) return { copied: [] }
  const missing = LOADABLE.filter((file) => !present.includes(file))
  if (missing.length > 0) {
    throw new Error(
      `core wasm artifact is half staged: ${missing.join(', ')} not found in ${srcDir} — re-run \`pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm\``,
    )
  }
  mkdirSync(destDir, { recursive: true })
  const copied = CORE_WASM_FILES.filter((file) => existsSync(resolve(srcDir, file)))
  for (const file of copied) cpSync(resolve(srcDir, file), resolve(destDir, file))
  return { copied }
}

if (isRunAsScript(import.meta.url)) {
  const { copied } = copyCoreWasmIntoDist()
  console.log(
    copied.length === 0
      ? `no core wasm staged in ${SRC_DIR}; dist carries none (\`prepack\` will refuse to pack)`
      : `copied ${copied.length} files ${SRC_DIR} -> ${DEST_DIR}`,
  )
}
