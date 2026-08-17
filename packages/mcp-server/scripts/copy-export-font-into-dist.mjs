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
// Also consumed by verify-export-font-dist.mjs (prefixed with 'dist') so the
// packed-asset gate and this copy step cannot drift apart on the paths.
// Four static faces: layout measures emphasis runs at real bold/italic
// widths and resvg does not synthesize a missing face.
export const FONT_DIR_SEGMENTS = ['assets', 'fonts', 'Roboto']
export const FONT_FILES = [
  'Roboto-Regular.ttf',
  'Roboto-Bold.ttf',
  'Roboto-Italic.ttf',
  'Roboto-BoldItalic.ttf',
  'LICENSE.txt',
]
export const SRC_DIR = resolve(SCRIPT_DIR, '..', ...FONT_DIR_SEGMENTS)
export const DEST_DIR = resolve(SCRIPT_DIR, '..', 'dist', ...FONT_DIR_SEGMENTS)

export function copyExportFontIntoDist(srcDir = SRC_DIR, destDir = DEST_DIR) {
  mkdirSync(destDir, { recursive: true })
  for (const file of FONT_FILES) {
    const srcFile = resolve(srcDir, file)
    if (!existsSync(srcFile)) {
      throw new Error(
        `export font asset not found at ${srcFile} — is assets/fonts/Roboto committed?`,
      )
    }
    cpSync(srcFile, resolve(destDir, file))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  copyExportFontIntoDist()
  console.log(`copied ${FONT_FILES.length} files ${SRC_DIR} -> ${DEST_DIR}`)
}
