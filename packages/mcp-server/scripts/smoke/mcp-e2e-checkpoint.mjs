#!/usr/bin/env node
// End-to-end smoke test that runs through an MCP stdio subprocess.
//
// Purpose:
// Start the MCP server outside the parent client's context and verify that each
// tool behaves according to spec even with no prior conversation context, using
// JSON-RPC stdio. This is the standard repeatable verification pattern when you
// want deterministic behavior without reconnecting the main client.
//
// Coverage:
//   1. canvas_create -> annotate -> canvas_inspect
//   2. checkpoint_save -> checkpoint_restore -> canvas_inspect element recovery
//   3. checkpoint_restore branches for overwrite=true and validation errors
//   4. viewport_set rejects immediately with no_client when no browser is connected
//   5. export_canvas(format:png/svg/json) succeeds via headless rendering with no browser connected
//
// For 4 and 5 there is no browser WS client, so success behavior is not
// observed. Instead, the smoke proves that both route wiring and MCP wrapping
// are correct because the no_client error is returned immediately.
//
// This does not consume API quota, so it is safe in CI. For real LLM-driven
// execution, use scripts/smoke/mcp-claude-cli-smoke.mjs.

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')
const entryArg = process.argv.find((arg) => arg.startsWith('--entry='))
const entry = resolve(
  root,
  entryArg ? entryArg.slice('--entry='.length) : 'src/server/mcp/index.ts',
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
