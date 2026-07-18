#!/usr/bin/env node
import { existsSync, renameSync } from 'node:fs'
// Vite's HTML build output keeps the input filename (canvas-viewer.widget.html,
// distinguishable from the source dir listing at a glance); this renames it
// to the canonical published artifact path documented in
// docs/contributing/development.md.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distWidgetDir = resolve(__dirname, '../dist/widget')
const from = join(distWidgetDir, 'canvas-viewer.widget.html')
const to = join(distWidgetDir, 'canvas-viewer.html')

if (!existsSync(from)) {
  console.error(`[rename-widget-html] expected build output at ${from}`)
  process.exit(1)
}

renameSync(from, to)
