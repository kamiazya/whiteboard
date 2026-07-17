#!/usr/bin/env node
// Launches the claude CLI as a subprocess and verifies that the MCP server
// behaves correctly for an LLM client with no prior context.
//
// Purpose:
// Ensure tools can still be discovered and called in the expected order even
// without relying on prompts or conversation history from the parent client.
//
// Expected behavior:
// Call canvas_create -> annotate -> version_save as one flow and succeed if
// the last line prints a versionId.
//
// Notes:
// This consumes API quota, so it does not run in CI. Manual use:
//   node scripts/smoke/mcp-claude-cli-smoke.mjs
// For a lightweight version that does not consume quota and talks directly to
// JSON-RPC stdio, use scripts/smoke/mcp-e2e-smoke.mjs.
// CI images ship without the claude CLI installed (by design — this smoke
// needs a local install and live API quota), so the release-gate scripts
// that chain into this one (smoke:distribution:packaged, test:e2e:distribution)
// would otherwise always fail with `spawn claude ENOENT`. Skip cleanly instead.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCliAvailable } from './lib/cli-available.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

if (!isCliAvailable('claude')) {
  console.log(
    '[claude-smoke] SKIP: claude CLI not found on PATH — this smoke needs a local claude install and API quota (manual/dev-machine check)',
  )
  process.exit(0)
}

const tmpDataDir = mkdtempSync(join(tmpdir(), 'whiteboard-claude-smoke-'))
const mcpConfigPath = join(tmpDataDir, 'mcp.json')

const mcpConfig = {
  mcpServers: {
    excalidraw: {
      type: 'stdio',
      command: 'npx',
      args: ['tsx', join(root, 'src/server/mcp/index.ts')],
      env: { WHITEBOARD_DATA_DIR: tmpDataDir },
    },
  },
}
writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig))

const prompt = [
  'Use the excalidraw MCP server.',
  'Do exactly these three steps in order, no extra work:',
  '1. call canvas_create with slug="claude-smoke".',
  '2. call annotate with type=rectangle at {x:10,y:10}, width=40, height=20 on the canvas id returned above.',
  '3. call version_save for that canvas id with label "claude-smoke".',
  'Return only the versionId on the last line, nothing else.',
].join('\n')

const args = [
  '-p',
  prompt,
  '--mcp-config',
  mcpConfigPath,
  '--strict-mcp-config',
  '--allowedTools',
  'mcp__excalidraw__canvas_create mcp__excalidraw__annotate mcp__excalidraw__version_save',
  '--max-turns',
  '6',
  '--output-format',
  'text',
]

const child = spawn('claude', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })

let stdout = ''
let stderr = ''
child.stdout.on('data', (c) => {
  stdout += c.toString()
})
child.stderr.on('data', (c) => {
  stderr += c.toString()
})

const killTimer = setTimeout(() => {
  child.kill('SIGTERM')
}, 90_000)

child.on('exit', (code) => {
  clearTimeout(killTimer)
  rmSync(tmpDataDir, { recursive: true, force: true })
  if (code !== 0) {
    console.error(`[claude-smoke] claude exited with ${code}`)
    if (stderr) console.error(stderr)
    process.exit(code ?? 1)
  }
  const lines = stdout.trim().split('\n').filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  // versionId is a nanoid string; match a generic alphanumeric run.
  const m = last.match(/([A-Za-z0-9_-]{6,})/)
  if (!m) {
    console.error('[claude-smoke] FAIL: no versionId in output')
    console.error('--- stdout ---')
    console.error(stdout)
    process.exit(1)
  }
  console.log(`[claude-smoke] OK: versionId=${m[1]}`)
  process.exit(0)
})
