#!/usr/bin/env node
// prepack gate: fails the pack/publish when the canvas-viewer widget was
// never copied in (see copy-widget-into-dist.mjs). Without this, a `pnpm
// publish` run against a stale or partial `dist/` would ship a tarball
// whose ui://whiteboard/canvas-view resource 500s at read time with no
// build-time signal.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPrepackGate } from './prepack-gate-lib.mjs'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function findMissingWidgetHtml(packageRoot = PACKAGE_ROOT) {
  const htmlPath = resolve(packageRoot, 'dist', 'widget', 'canvas-viewer.html')
  return existsSync(htmlPath) ? null : htmlPath
}

runPrepackGate(import.meta.url, {
  find: findMissingWidgetHtml,
  remedy:
    "run `pnpm build` (canvas-viewer's build:widget + copy-widget-into-dist.mjs) before packing.",
  present: 'dist/widget/canvas-viewer.html present',
})
