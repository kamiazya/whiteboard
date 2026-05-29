#!/usr/bin/env node
// Direct invocation requires tsx:
//   node --import tsx/esm scripts/mcp-packed-tarball-smoke.mjs
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '..')
const repoRoot = resolve(packageRoot, '../..')

try {
  const { runPackedTarballSmoke } = await import(
    resolve(packageRoot, 'src/server/mcp/tarball.distribution-impl.ts')
  )
  await runPackedTarballSmoke({ packageRoot, repoRoot })
} catch (err) {
  console.error(`[tarball-smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
