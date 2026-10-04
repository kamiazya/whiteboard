#!/usr/bin/env node
// prepack gate: fails the pack/publish when the export font asset was never
// copied into dist/ (see copy-export-font-into-dist.mjs). Without this, a
// published tarball missing the font would silently degrade every export to
// the constant-ratio fallback measurer with no build-time signal.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FONT_DIR_SEGMENTS, FONT_FILES } from './copy-export-font-into-dist.mjs'
import { runPrepackGate } from './prepack-gate-lib.mjs'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function findMissingExportFont(packageRoot = PACKAGE_ROOT) {
  for (const file of FONT_FILES) {
    const fontPath = resolve(packageRoot, 'dist', ...FONT_DIR_SEGMENTS, file)
    if (!existsSync(fontPath)) return fontPath
  }
  return null
}

runPrepackGate(import.meta.url, {
  find: findMissingExportFont,
  remedy:
    'run `pnpm build` (copy-export-font-into-dist.mjs copies the vendored font into dist/assets) before packing.',
  present: 'dist/assets/fonts/Roboto faces present',
})
