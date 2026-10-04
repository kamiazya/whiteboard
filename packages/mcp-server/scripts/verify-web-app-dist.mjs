#!/usr/bin/env node
// prepack gate: fails the pack/publish when apps/web's build was never
// copied in (see apps/web/scripts/copy-into-mcp-dist.mjs). Without this,
// a `pnpm publish` run against a stale or partial `dist/` would ship a
// tarball whose local daemon silently falls back to the legacy UI (or
// serves nothing) with no build-time signal.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPrepackGate } from './prepack-gate-lib.mjs'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function findMissingWebAppDistIndex(packageRoot = PACKAGE_ROOT) {
  const indexPath = resolve(packageRoot, 'dist', 'web-app', 'index.html')
  return existsSync(indexPath) ? null : indexPath
}

runPrepackGate(import.meta.url, {
  find: findMissingWebAppDistIndex,
  remedy:
    "run `pnpm build` (apps/web's postbuild copies its build into dist/web-app) before packing.",
  present: 'dist/web-app/index.html present',
})
