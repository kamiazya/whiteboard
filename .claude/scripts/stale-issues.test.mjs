#!/usr/bin/env node
// stale-issues.mjs as the SessionStart hook runs it: a subprocess that reaches
// the daemon through the socket its record names, never through a port.
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { startFakeMcpResponder } from '../../packages/mcp-server/scripts/dev/test-utils/fake-mcp-daemon.mjs'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'stale-issues.mjs')

test('asks the daemon on its recorded socket, and never connects to the dev port', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'stale-issues-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const socketPath = join(dataDir, 'daemon.sock')
  const responder = await startFakeMcpResponder({ socketPath, token: 'tok' })
  t.after(responder.close)
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ socketPath }))

  let tcpConnections = 0
  const tcp = createServer((socket) => {
    tcpConnections += 1
    socket.destroy()
  })
  await new Promise((listening) => tcp.listen(0, '127.0.0.1', listening))
  t.after(() => new Promise((closed) => tcp.close(closed)))

  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      WHITEBOARD_DATA_DIR: dataDir,
      WHITEBOARD_TOKEN: 'tok',
      WHITEBOARD_DEV_PORT: String(tcp.address().port),
    },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  await new Promise((closed) => child.once('close', closed))

  assert.equal(stderr, '')
  // The fake daemon answers every tool with an empty result: no issues.
  assert.match(stdout, /nothing to report — 0 of 0/)
  assert.equal(tcpConnections, 0)
})
