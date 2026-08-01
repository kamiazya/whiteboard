#!/usr/bin/env node
// prepack gate: fails the pack/publish when the export font asset was never
// copied into dist/ (see copy-export-font-into-dist.mjs). Without this, a
// published tarball missing the font would silently degrade every export to
// the constant-ratio fallback measurer with no build-time signal.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FONT_RELATIVE_SEGMENTS } from './copy-export-font-into-dist.mjs'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function findMissingExportFont(packageRoot = PACKAGE_ROOT) {
  const fontPath = resolve(packageRoot, 'dist', ...FONT_RELATIVE_SEGMENTS)
  return existsSync(fontPath) ? null : fontPath
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = findMissingExportFont()
  if (missing) {
    console.error(
      `prepack gate: ${missing} not found — run \`pnpm build\` (copy-export-font-into-dist.mjs copies the vendored font into dist/assets) before packing.`,
    )
    process.exit(1)
  }
  // stderr, not stdout: npm interleaves lifecycle-script stdout with the
  // `npm pack --json` payload, so anything printed here on stdout corrupts
  // JSON consumers of the pack output (e.g. the release pack-contents check).
  console.error('prepack gate: dist/assets/fonts/Roboto/Roboto-Regular.ttf present — OK')
}
