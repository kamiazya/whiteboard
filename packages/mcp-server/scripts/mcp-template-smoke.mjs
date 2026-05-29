#!/usr/bin/env node
// Direct smoke test for template_list / template_insert.
// Calls the tool functions directly instead of going through MCP, with fetch
// mocked so the test completes without starting Hono. It also covers error
// cases such as unknown id, both/neither, missing variable, and bad path.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const dataDir = mkdtempSync(join(tmpdir(), 'tpl-smoke-'))
process.env.WHITEBOARD_DATA_DIR = dataDir
process.chdir(root)

try {
  const { runTemplateSmokeChecks } = await import(
    join(root, 'src/server/mcp/tools/template.smoke-impl.ts')
  )
  await runTemplateSmokeChecks()
  console.log('\n[tpl-smoke] ALL OK')
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
