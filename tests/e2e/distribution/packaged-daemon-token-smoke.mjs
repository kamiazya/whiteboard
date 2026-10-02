#!/usr/bin/env node
// Smoke: `whiteboard daemon run --json` token input hardening at the
// packaged-artifact boundary.
//
// Tests token input precedence and non-leak contract without relying
// on unit-test mocks. Three scenarios use spawnSync (no real daemon
// bind); one scenario spawns a short-lived real daemon to verify
// the env-token path at the distribution boundary.
//
// Scenarios:
//   1. removed argv token: --token=<value> → exit 64, stderr safe (no raw token)
//   2. env+stdin conflict: WHITEBOARD_DAEMON_TOKEN + --token-stdin → exit 1, stderr safe
//   3. env token daemon run → env token in record, stdout/stderr safe, and
//      the record's token (and no other) opens the daemon's socket
//   4. auto-generate: no token source → generated token in record, stdout/stderr safe
//
// The daemon listens on its owner-only socket and no TCP port (ADR-0050),
// so each real run gets its own data dir and nothing here can collide.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertNoLeak, createCliRunner, createFail, scrubDevEnv } from './smoke-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const CLI = resolve(REPO_ROOT, 'packages/mcp-server/dist/cli/index.js')

if (!existsSync(CLI)) {
  console.error(
    '[token-smoke] FAIL: dist/cli/index.js missing.\n' + 'Run `pnpm build:mcp` before this smoke.',
  )
  process.exit(1)
}

const READINESS_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 10_000

// assertNoLeak (BASE_LEAK_PATTERNS) is imported from smoke-helpers.mjs.
// Dynamic token values (smoke-argv-secret-token, ENV_TOKEN, stdin-conflict-token,
// record.token) are checked with explicit includes() below each scenario —
// they cannot be expressed as static patterns.

const fail = createFail('token-smoke')

const runCli = createCliRunner(CLI, { timeout: 10_000 })

// --- Scenario 1: --token= removed (argv secrets) -------------------------
{
  const r = runCli(['daemon', 'run', '--json', '--token=smoke-argv-secret-token'])
  if (r.status !== 64) fail(`scenario 1: expected exit 64, got ${r.status}`, { stderr: r.stderr })
  if (r.stdout.trim() !== '') fail('scenario 1: stdout must be empty', { stdout: r.stdout })
  assertNoLeak('scenario 1 stderr', r.stderr)
  if (r.stderr.includes('smoke-argv-secret-token')) fail('scenario 1: raw token in stderr')
  if (!r.stderr.includes('--token'))
    fail('scenario 1: error must mention --token', { stderr: r.stderr })
  console.log('[token-smoke] scenario 1 PASS: --token=<value> → exit 64, stderr safe')
}

// --- Scenario 2: env+stdin conflict ------------------------------------
{
  const ENV_TOKEN = 'smoke-env-conflict-token-XYZ'
  const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-token-smoke-s2-'))
  try {
    const r = runCli(['daemon', 'run', '--json', '--token-stdin', `--data-dir=${dataDir}`], {
      input: 'stdin-conflict-token\n',
      env: { WHITEBOARD_DAEMON_TOKEN: ENV_TOKEN },
    })
    if (r.status !== 1) fail(`scenario 2: expected exit 1, got ${r.status}`, { stderr: r.stderr })
    if (r.stdout.trim() !== '') fail('scenario 2: stdout must be empty', { stdout: r.stdout })
    assertNoLeak('scenario 2 stderr', r.stderr)
    if (r.stderr.includes(ENV_TOKEN)) fail('scenario 2: env token in stderr')
    if (r.stderr.includes('stdin-conflict-token')) fail('scenario 2: stdin token in stderr')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
  console.log('[token-smoke] scenario 2 PASS: env+stdin conflict → exit 1, stderr safe')
}

// --- Scenarios 3 & 4: real daemon runs ----------------------------------
/** GET /api/runtime/status over the daemon's socket under `token`; answers the status. */
function socketStatus(socketPath, token) {
  return new Promise((done, reject) => {
    const req = request(
      { socketPath, path: '/api/runtime/status', headers: { authorization: `Bearer ${token}` } },
      (res) => {
        res.resume()
        res.on('end', () => done(res.statusCode))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function runDaemonScenario(label, extraEnv, extraArgs, baseEnv = scrubDevEnv(process.env)) {
  const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-token-smoke-daemon-'))
  let stdoutBuf = ''
  let stderrBuf = ''
  let firstLineResolve
  const firstLine = new Promise((r) => {
    firstLineResolve = r
  })

  const child = spawn(
    process.execPath,
    [CLI, 'daemon', 'run', '--json', `--data-dir=${dataDir}`, ...extraArgs],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...baseEnv, ...extraEnv } },
  )
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    stdoutBuf += text
    const nl = stdoutBuf.indexOf('\n')
    if (nl !== -1) firstLineResolve(stdoutBuf.slice(0, nl))
  })
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString()
  })

  const closed = new Promise((r) => child.once('close', r))

  async function shutdown() {
    if (child.exitCode !== null) return
    try {
      child.kill('SIGTERM')
    } catch {
      /* gone */
    }
    const winner = await Promise.race([closed, delay(SHUTDOWN_TIMEOUT_MS, 'timeout')])
    if (winner === 'timeout') {
      try {
        child.kill('SIGKILL')
      } catch {
        /* gone */
      }
      await closed
    }
  }

  try {
    const winner = await Promise.race([firstLine, delay(READINESS_TIMEOUT_MS, 'timeout')])
    if (winner === 'timeout') {
      await shutdown()
      fail(`${label}: daemon did not emit ready JSON within ${READINESS_TIMEOUT_MS}ms`, {
        stderr: stderrBuf,
      })
    }

    let ready
    try {
      ready = JSON.parse(winner)
    } catch {
      fail(`${label}: first stdout line not valid JSON`, { line: winner })
    }
    if (!ready.ok) fail(`${label}: ready.ok not true`, { ready })
    if (typeof ready.socketPath !== 'string' || 'port' in ready || 'host' in ready)
      fail(`${label}: ready JSON names a socket and no port or host`, { ready })

    // Read the daemon record to get the token
    const recordPath = join(dataDir, 'daemon.json')
    if (!existsSync(recordPath)) fail(`${label}: daemon.json not found`)
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    if (!record.token || record.token.length < 8)
      fail(`${label}: daemon record has no token or token too short`)

    // Non-leak: the token from the record must not appear in stdout or stderr
    if (stdoutBuf.includes(record.token)) fail(`${label}: token leaked to stdout`)
    if (stderrBuf.includes(record.token)) fail(`${label}: token leaked to stderr`)
    assertNoLeak(`${label} stdout`, stdoutBuf)
    assertNoLeak(`${label} stderr`, stderrBuf)

    const authorized = await socketStatus(record.socketPath, record.token)
    const forged = await socketStatus(record.socketPath, 'not-the-daemon-token')
    if (authorized !== 200 || forged !== 401)
      fail(`${label}: the socket admits the record's token and only it`, { authorized, forged })

    return { record, stdoutBuf, stderrBuf }
  } finally {
    await shutdown()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

// Scenario 3: env token
{
  const ENV_TOKEN = 'smoke-env-daemon-token-fixture-AAABBB'
  const { record } = await runDaemonScenario(
    'scenario 3',
    { WHITEBOARD_DAEMON_TOKEN: ENV_TOKEN },
    [],
  )
  if (record.token !== ENV_TOKEN)
    fail(
      `scenario 3: daemon record token does not match env token (got ${record.token.slice(0, 8)}…)`,
    )
  console.log('[token-smoke] scenario 3 PASS: env token in record, stdout/stderr safe')
}

// Scenario 4: auto-generate (no token arg or env)
// Explicitly remove WHITEBOARD_DAEMON_TOKEN from the base env so a CI
// environment that has the variable set doesn't silently exercise the
// env-token path instead of the auto-generate path.
{
  const baseEnv = { ...scrubDevEnv(process.env) }
  delete baseEnv.WHITEBOARD_DAEMON_TOKEN
  const envCanary = process.env.WHITEBOARD_DAEMON_TOKEN
  const { record } = await runDaemonScenario('scenario 4', {}, [], baseEnv)
  // Token must be present and not trivially short (auto-gen is ~43 base64url chars)
  if (record.token.length < 20) fail(`scenario 4: auto-generated token suspiciously short`)
  // If the host env had WHITEBOARD_DAEMON_TOKEN set, the generated token must differ
  if (envCanary !== undefined && record.token === envCanary)
    fail('scenario 4: record token matches host WHITEBOARD_DAEMON_TOKEN — env was not excluded')
  console.log('[token-smoke] scenario 4 PASS: auto-generate token in record, stdout/stderr safe')
}

console.log('[token-smoke] All scenarios PASSED.')
