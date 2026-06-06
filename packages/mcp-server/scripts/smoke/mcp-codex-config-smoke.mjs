#!/usr/bin/env node
// Direct invocation requires tsx:
//   node --import tsx/esm scripts/smoke/mcp-codex-config-smoke.mjs
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '../..')
const repoRoot = resolve(packageRoot, '../..')

try {
  const { runCodexConfigSmoke } = await import(
    resolve(packageRoot, 'src/server/mcp/codex-config.distribution-impl.ts')
  )
  await runCodexConfigSmoke({ packageRoot, repoRoot })
} catch (err) {
  console.error(`[codex-config-smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
