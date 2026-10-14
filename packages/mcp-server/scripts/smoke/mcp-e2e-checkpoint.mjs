#!/usr/bin/env node
// End-to-end smoke test that runs through an MCP stdio subprocess.
//
// Purpose:
// A CLI entry to the same checkpoint flow the `mcp-smoke` Vitest project runs
// (mcp-e2e-checkpoint.smoke.test.ts), through the shared
// mcp-e2e-checkpoint.smoke-impl.ts, against a fresh data dir.
//
// Coverage:
//   1. tools/list equals ALL_REGISTERED_TOOLS in mcp-smoke-coverage.ts
//   2. wb_workspace_edit creates and moves a document
//   3. wb_facet_set seeds its state
//   4. wb_version_save -> wb_version_list -> wb_version_restore
//
// The full tool tour is `pnpm smoke:e2e` (mcp-e2e-smoke.mjs), a different and
// much wider flow.
//
// This does not consume API quota, so it is safe in CI. For real LLM-driven
// execution, use scripts/smoke/mcp-claude-cli-smoke.mjs.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')
const entryArg = process.argv.find((arg) => arg.startsWith('--entry='))
const entry = resolve(
  root,
  entryArg ? entryArg.slice('--entry='.length) : 'src/server/mcp/stdio.ts',
)

process.on('SIGINT', () => process.exit(130))

try {
  const { runE2eCheckpointSmoke } = await import(
    resolve(root, 'src/server/mcp/mcp-e2e-checkpoint.smoke-impl.ts')
  )
  await runE2eCheckpointSmoke({ entry, root })
} catch (err) {
  console.error(`[e2e] FAIL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
