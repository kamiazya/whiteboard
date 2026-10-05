#!/usr/bin/env node
// stale-issues.mjs as the SessionStart hook runs it: a subprocess that reaches
// the daemon through the socket its record names, never through a port.
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { startFakeMcpResponder } from '../../packages/mcp-server/scripts/dev/test-utils/fake-mcp-daemon.mjs'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'stale-issues.mjs')

/**
 * A scratch HOME for every run: the script reads ~/.claude.json, and the developer's real one
 * must neither leak into an assertion nor be reachable from this suite.
 */
function scratchHome(t, claudeConfig) {
  const home = mkdtempSync(join(tmpdir(), 'stale-issues-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  if (claudeConfig !== undefined) {
    writeFileSync(join(home, '.claude.json'), JSON.stringify(claudeConfig))
  }
  return { HOME: home, USERPROFILE: home }
}

async function run(args, env) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const code = await new Promise((closed) => child.once('close', closed))
  return { code, stdout, stderr }
}

async function fakeDaemon(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'stale-issues-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const socketPath = join(dataDir, 'daemon.sock')
  const responder = await startFakeMcpResponder({ socketPath, token: 'tok' })
  t.after(responder.close)
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: process.pid, socketPath }))
  return dataDir
}

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
      ...scratchHome(t),
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
  assert.match(stdout, /holds 0 issue documents/)
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
    env: {
      ...process.env,
      ...scratchHome(t),
      WHITEBOARD_DATA_DIR: dataDir,
      WHITEBOARD_TOKEN: 'tok',
    },
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

// The hook passes --quiet, which means "nothing to report", and three different states used to
// print the same nothing: a store the check could not reach, a store holding no issue at all,
// and a store whose issues are all current. Only the last is good news.
test('under --quiet, a store it cannot reach still says so', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'stale-issues-absent-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))

  const { code, stderr } = await run(['--quiet'], {
    ...scratchHome(t),
    WHITEBOARD_DATA_DIR: dataDir,
    WHITEBOARD_TOKEN: 'tok',
  })

  assert.equal(code, 0)
  assert.match(stderr, /\[stale-issues\] skipped: the dev daemon is not running/)
})

test('under --quiet, a store holding no issue document says so rather than nothing', async (t) => {
  const dataDir = await fakeDaemon(t)

  const { code, stdout, stderr } = await run(['--quiet'], {
    ...scratchHome(t),
    WHITEBOARD_DATA_DIR: dataDir,
    WHITEBOARD_TOKEN: 'tok',
  })

  assert.equal(code, 0)
  assert.equal(stderr, '')
  assert.match(stdout, /\[stale-issues\] workspace "default" holds 0 issue documents/)
})

test('under --quiet, a `whiteboard` registration naming a proxy that no longer exists is reported with the command that repairs it', async (t) => {
  const mainRoot = resolve(
    execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: dirname(SCRIPT),
      encoding: 'utf8',
    }).trim(),
    '..',
  )
  const gone = mkdtempSync(join(tmpdir(), 'stale-issues-gone-'))
  rmSync(gone, { recursive: true, force: true })
  const script = join(gone, 'packages', 'mcp-server', 'scripts', 'dev', 'mcp-http-stdio-proxy.mjs')
  const home = scratchHome(t, {
    projects: {
      [mainRoot]: {
        mcpServers: { whiteboard: { type: 'stdio', command: 'node', args: [script], env: {} } },
      },
    },
  })
  const dataDir = await fakeDaemon(t)

  const { code, stdout } = await run(['--quiet'], {
    ...home,
    WHITEBOARD_DATA_DIR: dataDir,
    WHITEBOARD_TOKEN: 'tok',
  })

  assert.equal(code, 0)
  const note = stdout.split('\n').find((line) => line.includes(script))
  assert.ok(note, stdout)
  assert.match(stdout, /claude mcp remove whiteboard -s local/)
  assert.match(stdout, /claude mcp add --scope local --transport stdio whiteboard -- node /)
})

test('a `whiteboard` registration whose proxy exists is not reported', async (t) => {
  const mainRoot = resolve(
    execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: dirname(SCRIPT),
      encoding: 'utf8',
    }).trim(),
    '..',
  )
  const live = mkdtempSync(join(tmpdir(), 'stale-issues-live-'))
  t.after(() => rmSync(live, { recursive: true, force: true }))
  const scriptDir = join(live, 'packages', 'mcp-server', 'scripts', 'dev')
  mkdirSync(scriptDir, { recursive: true })
  const script = join(scriptDir, 'mcp-http-stdio-proxy.mjs')
  writeFileSync(script, '')
  const home = scratchHome(t, {
    projects: {
      [mainRoot]: {
        mcpServers: { whiteboard: { type: 'stdio', command: 'node', args: [script], env: {} } },
      },
    },
  })
  const dataDir = await fakeDaemon(t)

  const { stdout } = await run(['--quiet'], {
    ...home,
    WHITEBOARD_DATA_DIR: dataDir,
    WHITEBOARD_TOKEN: 'tok',
  })

  assert.doesNotMatch(stdout, /claude mcp remove/)
})
