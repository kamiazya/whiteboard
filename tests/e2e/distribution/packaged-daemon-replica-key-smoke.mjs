#!/usr/bin/env node
// Smoke: `whiteboard daemon rotate-replica-key --json` and
// `whiteboard daemon set-replica-tier --json` at the packaged-artifact
// boundary, against a real daemon on its owner-only socket (ADR-0050).
//
// The two commands are the operator's entry point to a workspace's replica
// posture (ADR-0042's 2026-09-21 addenda); before them the only way to
// rotate a key suspected compromised was `curl --unix-socket` with the
// daemon token. What this checks is the part no unit test can: the built
// CLI finds the running daemon's record, is admitted at the
// `runtime:admin` bar under its token, and the key the daemon hands out
// afterwards is a DIFFERENT pair — the keyId the rotate reports is the one
// the key route then names, and it is not the one from before.
//
// Scenarios:
//   1. rotate on a workspace the daemon holds → ok, keyId changes, the key
//      route agrees
//   2. set-replica-tier bounded → the key route leases; default → the
//      override clears
//   3. rotate on a workspace the daemon does not hold → ok:false, refused,
//      the daemon's own 404 reason
//   4. rotate with no daemon running → ok:false, daemon-not-running, exit 1

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertNoLeak, createFail, scrubDevEnv } from './smoke-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const CLI = resolve(REPO_ROOT, 'packages/mcp-server/dist/cli/index.js')

if (!existsSync(CLI)) {
  console.error(
    '[replica-key-smoke] FAIL: dist/cli/index.js missing.\n' +
      'Run `pnpm build:mcp` before this smoke.',
  )
  process.exit(1)
}

const READINESS_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 10_000

const fail = createFail('replica-key-smoke')

/** One JSON request over the daemon's socket under its token. */
function socketJson(record, method, path, body) {
  return new Promise((done, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        socketPath: record.socketPath,
        method,
        path,
        headers: {
          authorization: `Bearer ${record.token}`,
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          let parsed
          try {
            parsed = text === '' ? undefined : JSON.parse(text)
          } catch {
            parsed = text
          }
          done({ status: res.statusCode, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** The built CLI, one JSON object on stdout. */
function runCliJson(args, env) {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  })
  let json
  try {
    json = run.stdout === '' ? undefined : JSON.parse(run.stdout)
  } catch {
    fail(`stdout is not one JSON object for ${args.join(' ')}`, { stdout: run.stdout })
  }
  return { status: run.status, json, stdout: run.stdout, stderr: run.stderr }
}

async function withDaemon(run) {
  const env = scrubDevEnv(process.env)
  const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-replica-key-smoke-'))
  let stdoutBuf = ''
  let stderrBuf = ''
  let firstLineResolve
  const firstLine = new Promise((r) => {
    firstLineResolve = r
  })
  const child = spawn(process.execPath, [CLI, 'daemon', 'run', '--json', `--data-dir=${dataDir}`], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString()
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
    if ((await Promise.race([closed, delay(SHUTDOWN_TIMEOUT_MS, 'timeout')])) === 'timeout') {
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
      fail(`daemon did not emit ready JSON within ${READINESS_TIMEOUT_MS}ms`, { stderr: stderrBuf })
    }
    const ready = JSON.parse(winner)
    if (!ready.ok) fail('ready.ok not true', { ready })
    const record = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8'))
    await run({ record, dataDir, env })
  } finally {
    await shutdown()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

/** Scenario 1: rotate, and the key route agrees about which pair it is now. */
async function rotateScenario({ record, dataDirArg, env }, workspaceId, keyBefore) {
  const rotated = runCliJson(
    ['daemon', 'rotate-replica-key', '--json', `--workspace=${workspaceId}`, dataDirArg],
    env,
  )
  if (rotated.status !== 0 || rotated.json?.ok !== true || typeof rotated.json.keyId !== 'string') {
    fail('rotate-replica-key did not report ok with a keyId', rotated)
  }
  if (rotated.json.keyId === keyBefore.keyId) {
    fail('rotate-replica-key reported the keyId from before the rotation', {
      before: keyBefore.keyId,
      after: rotated.json.keyId,
    })
  }
  const keyAfter = await socketJson(record, 'POST', `/api/workspaces/${workspaceId}/replica-key`)
  if (keyAfter.body?.keyId !== rotated.json.keyId) {
    fail('the key route names a different pair than the rotation reported', {
      reported: rotated.json.keyId,
      served: keyAfter.body?.keyId,
    })
  }
  if (keyAfter.body.workspaceKey === keyBefore.workspaceKey) {
    fail('the workspace key did not change under rotation')
  }
  for (const [label, text] of [
    ['rotate stdout', rotated.stdout],
    ['rotate stderr', rotated.stderr],
  ]) {
    assertNoLeak(label, text)
    if (text.includes(record.token)) fail(`${label} leaked the daemon token`)
    if (text.includes(keyAfter.body.workspaceKey)) fail(`${label} leaked the workspace key`)
  }
  console.log(`[replica-key-smoke] rotate → keyId ${keyBefore.keyId} -> ${rotated.json.keyId}`)
}

/** Scenario 2: the tier override, set and cleared. */
async function tierScenario({ record, dataDirArg, env }, workspaceId) {
  const tierArgs = (tier) => [
    'daemon',
    'set-replica-tier',
    '--json',
    `--workspace=${workspaceId}`,
    `--tier=${tier}`,
    dataDirArg,
  ]
  const bounded = runCliJson(tierArgs('bounded'), env)
  if (bounded.status !== 0 || bounded.json?.effectiveTier !== 'bounded') {
    fail('set-replica-tier bounded did not take', bounded)
  }
  const leased = await socketJson(record, 'POST', `/api/workspaces/${workspaceId}/replica-key`)
  if (leased.body?.tier !== 'bounded' || typeof leased.body.leaseExpiresAt !== 'string') {
    fail('the key route does not lease after set-replica-tier bounded', leased)
  }
  const cleared = runCliJson(tierArgs('default'), env)
  if (cleared.status !== 0 || cleared.json?.tier !== null) {
    fail('set-replica-tier default did not clear the override', cleared)
  }
  console.log(
    `[replica-key-smoke] set-replica-tier → bounded, then cleared to ${cleared.json.effectiveTier}`,
  )
}

/** Scenario 3: a workspace the daemon does not hold is the daemon's refusal. */
function unknownWorkspaceScenario({ dataDirArg, env }) {
  const absent = runCliJson(
    ['daemon', 'rotate-replica-key', '--json', '--workspace=nope', dataDirArg],
    env,
  )
  if (absent.status !== 1 || absent.json?.ok !== false || absent.json.reason !== 'refused') {
    fail('rotate-replica-key on an unknown workspace is not reported as refused', absent)
  }
  if (absent.json.status !== 404) fail('the refusal does not carry the daemon status', absent)
  console.log(
    `[replica-key-smoke] unknown workspace → refused ${absent.json.status}: ${absent.json.message}`,
  )
}

await withDaemon(async ({ record, dataDir, env }) => {
  const created = await socketJson(record, 'POST', '/api/workspaces', { displayName: 'Rotated' })
  if (created.status !== 201 && created.status !== 200) {
    fail('could not create a workspace to rotate', created)
  }
  const workspaceId = created.body.workspaceId
  const keyBefore = await socketJson(record, 'POST', `/api/workspaces/${workspaceId}/replica-key`)
  if (keyBefore.status !== 200) fail('the key route refused before rotation', keyBefore)

  const ctx = { record, dataDirArg: `--data-dir=${dataDir}`, env }
  await rotateScenario(ctx, workspaceId, keyBefore.body)
  await tierScenario(ctx, workspaceId)
  unknownWorkspaceScenario(ctx)
})

// Scenario 4: no daemon.
{
  const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-replica-key-smoke-nodaemon-'))
  try {
    const down = runCliJson(
      ['daemon', 'rotate-replica-key', '--json', '--workspace=ws', `--data-dir=${dataDir}`],
      scrubDevEnv(process.env),
    )
    if (down.status !== 1 || down.json?.reason !== 'daemon-not-running') {
      fail('rotate-replica-key without a daemon is not reported as daemon-not-running', down)
    }
    console.log('[replica-key-smoke] no daemon → daemon-not-running, exit 1')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

console.log('[replica-key-smoke] PASS')
