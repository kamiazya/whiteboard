#!/usr/bin/env node
// Startup smoke test for the MCP server.
// Spawns src/server/mcp/index.ts via node --import tsx/esm and verifies that
// no SyntaxError or immediate exit happens within 3 seconds.
// This guards against regressions where missing exports break startup.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const whiteboardRoot = resolve(__dirname, '..')
const tmpDataDir = mkdtempSync(join(tmpdir(), 'whiteboard-smoke-'))

const child = spawn('node', ['--import', 'tsx/esm', 'src/server/mcp/index.ts'], {
  cwd: whiteboardRoot,
  env: { ...process.env, WHITEBOARD_DATA_DIR: tmpDataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stderr = ''
let exited = false
let exitCode = null

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})
child.on('exit', (code) => {
  exited = true
  exitCode = code
})

const WAIT_MS = 3000
await new Promise((r) => setTimeout(r, WAIT_MS))

// Detect fatal startup errors.
const fatalPatterns = [/SyntaxError/, /Cannot find module/, /does not provide an export/]
const fatal = fatalPatterns.find((p) => p.test(stderr))

// Cleanup.
if (!exited) child.kill('SIGTERM')
rmSync(tmpDataDir, { recursive: true, force: true })

if (fatal) {
  console.error(`[mcp-smoke] FAIL: matched ${fatal}`)
  console.error(stderr)
  process.exit(1)
}
if (exited && exitCode !== 0 && exitCode !== null) {
  console.error(`[mcp-smoke] FAIL: MCP exited with code ${exitCode} within ${WAIT_MS}ms`)
  console.error(stderr)
  process.exit(1)
}

console.log(`[mcp-smoke] OK: MCP stayed alive for ${WAIT_MS}ms`)
process.exit(0)
