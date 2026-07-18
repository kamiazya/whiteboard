#!/usr/bin/env node
// Build step: copies packages/canvas-viewer's self-contained widget HTML
// bundle into this package's dist so mcp-apps.ts can serve it as the
// ui://whiteboard/canvas-view resource. canvas-viewer has no workspace
// dependency on this package (mcp-server depends on canvas-viewer as a
// devDependency instead, purely for build ordering), so — unlike
// apps/web's postbuild copy-into-mcp-dist.mjs, which runs from the SOURCE
// package after its own build — this copy runs from mcp-server's OWN build
// step, pulling from a sibling package's already-built dist/.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const SRC_FILE = resolve(
  SCRIPT_DIR,
  '..',
  '..',
  'canvas-viewer',
  'dist',
  'widget',
  'canvas-viewer.html',
)
export const DEST_FILE = resolve(SCRIPT_DIR, '..', 'dist', 'widget', 'canvas-viewer.html')

export function copyWidgetIntoDist(srcFile = SRC_FILE, destFile = DEST_FILE) {
  if (!existsSync(srcFile)) {
    throw new Error(
      `canvas-viewer widget build output not found at ${srcFile} — run ` +
        '`pnpm --filter @kamiazya/whiteboard-canvas-viewer build:widget` first',
    )
  }
  mkdirSync(dirname(destFile), { recursive: true })
  cpSync(srcFile, destFile)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  copyWidgetIntoDist()
  console.log(`copied ${SRC_FILE} -> ${DEST_FILE}`)
}
