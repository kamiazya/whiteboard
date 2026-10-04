#!/usr/bin/env node
// stale-issues.mjs as the SessionStart hook runs it: a subprocess that reaches
// the daemon through the socket its record names, never through a port.
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: process.pid, socketPath }))

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

test('a daemon that accepts the connection and never answers ends the check inside its own bound', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'stale-issues-hung-'))
  const socketPath = join(dataDir, 'daemon.sock')
  const hung = createServer(() => {})
  await new Promise((listening) => hung.listen(socketPath, listening))
  t.after(() => {
    hung.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: process.pid, socketPath }))

  const child = spawn(process.execPath, [SCRIPT, '--quiet'], {
    env: { ...process.env, WHITEBOARD_DATA_DIR: dataDir, WHITEBOARD_TOKEN: 'tok' },
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  // Above the script's own bound and below the hook timeout it runs under; a script that has no
  // bound is killed here, so the test fails instead of hanging.
  const killer = setTimeout(() => child.kill('SIGKILL'), 12_000)
  const [code, signal] = await new Promise((closed) =>
    child.once('close', (c, s) => closed([c, s])),
  )
  clearTimeout(killer)

  assert.equal(signal, null, 'the check must end on its own')
  assert.equal(code, 0)
  assert.match(stderr, /\[stale-issues\] skipped: no answer within/)
})

test('every SessionStart hook declares a timeout, so none can hold a session start open', () => {
  const settings = JSON.parse(readFileSync(resolve(dirname(SCRIPT), '../settings.json'), 'utf8'))
  const hooks = settings.hooks.SessionStart.flatMap((group) => group.hooks)
  assert.ok(hooks.length >= 4, 'the SessionStart group is present')
  for (const hook of hooks) {
    assert.equal(typeof hook.timeout, 'number', `no timeout on: ${hook.command}`)
  }
})
