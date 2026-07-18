#!/usr/bin/env node
// prepack gate: fails the pack/publish when the canvas-viewer widget was
// never copied in (see copy-widget-into-dist.mjs). Without this, a `pnpm
// publish` run against a stale or partial `dist/` would ship a tarball
// whose ui://whiteboard/canvas-view resource 500s at read time with no
// build-time signal.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function findMissingWidgetHtml(packageRoot = PACKAGE_ROOT) {
  const htmlPath = resolve(packageRoot, 'dist', 'widget', 'canvas-viewer.html')
  return existsSync(htmlPath) ? null : htmlPath
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = findMissingWidgetHtml()
  if (missing) {
    console.error(
      `prepack gate: ${missing} not found — run \`pnpm build\` (canvas-viewer's build:widget + copy-widget-into-dist.mjs) before packing.`,
    )
    process.exit(1)
  }
  // stderr, not stdout — see verify-web-app-dist.mjs for why.
  console.error('prepack gate: dist/widget/canvas-viewer.html present — OK')
}
