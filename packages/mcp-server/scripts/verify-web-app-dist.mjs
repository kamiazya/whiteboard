#!/usr/bin/env node
// prepack gate: fails the pack/publish when apps/web's build was never
// copied in (see apps/web/scripts/copy-into-mcp-dist.mjs). Without this,
// a `pnpm publish` run against a stale or partial `dist/` would ship a
// tarball whose local daemon silently falls back to the legacy UI (or
// serves nothing) with no build-time signal.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function findMissingWebAppDistIndex(packageRoot = PACKAGE_ROOT) {
  const indexPath = resolve(packageRoot, 'dist', 'web-app', 'index.html')
  return existsSync(indexPath) ? null : indexPath
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = findMissingWebAppDistIndex()
  if (missing) {
    console.error(
      `prepack gate: ${missing} not found — run \`pnpm build\` (apps/web's postbuild copies its build into dist/web-app) before packing.`,
    )
    process.exit(1)
  }
  // stderr, not stdout: npm interleaves lifecycle-script stdout with the
  // `npm pack --json` payload, so anything printed here on stdout corrupts
  // JSON consumers of the pack output (e.g. the release pack-contents check).
  console.error('prepack gate: dist/web-app/index.html present — OK')
}
