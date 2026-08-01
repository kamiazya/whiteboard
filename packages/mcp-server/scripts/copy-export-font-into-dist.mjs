#!/usr/bin/env node
// Build step: copies the vendored export font asset into dist so the
// packaged/dev-daemon layout (dist/assets/fonts/...) matches what
// resolveExportFontFile (src/server/export/export-font.ts) actually
// resolves at runtime. Runs AFTER tsup (tsup's clean:true would otherwise
// wipe a copy placed before it), mirroring copy-widget-into-dist.mjs's
// ordering.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const FONT_RELATIVE_SEGMENTS = ['assets', 'fonts', 'Roboto', 'Roboto-Regular.ttf']
export const SRC_FILE = resolve(SCRIPT_DIR, '..', ...FONT_RELATIVE_SEGMENTS)
export const DEST_FILE = resolve(SCRIPT_DIR, '..', 'dist', ...FONT_RELATIVE_SEGMENTS)

export function copyExportFontIntoDist(srcFile = SRC_FILE, destFile = DEST_FILE) {
  if (!existsSync(srcFile)) {
    throw new Error(`export font asset not found at ${srcFile} — is assets/fonts/Roboto committed?`)
  }
  mkdirSync(dirname(destFile), { recursive: true })
  cpSync(srcFile, destFile)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  copyExportFontIntoDist()
  console.log(`copied ${SRC_FILE} -> ${DEST_FILE}`)
}
