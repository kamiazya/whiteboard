#!/usr/bin/env node
// Idempotent: probe port 3099, and if nothing is listening start
// `pnpm mcp:http:dev` detached so the next MCP request connects immediately.
//
// Wired into client `SessionStart` hooks so opening this repo auto-launches
// the dev daemon. Re-running this script is safe; if the port is already in
// use it exits without doing anything.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  waitForAuthenticatedMcp,
  resolveDevBearerToken,
  buildMcpHttpDevSpawnArgs,
} from './ensure-http-dev-daemon-lib.mjs'

const PORT = 3099
const HOST = '127.0.0.1'
// Upper bound on how long we'll wait for `pnpm mcp:http:dev` to bind. tsx
// + happy-dom + canvas + resvg cold start + node_modules linking can take
// ~10-15s on slow machines, so leave generous headroom. The hook is only
// invoked once per session start, so this isn't on a hot path.
const READY_TIMEOUT_MS = 30_000
const READY_POLL_INTERVAL_MS = 200
// Bearer token expected by `/mcp`. Must match the value the local clients
// (.claude/settings.json, .codex/config.toml) send. If a different daemon
// (or a non-whiteboard service) is on the port we'll see 401 / 4xx and
// refuse to claim success.
// Set WHITEBOARD_TOKEN in the shell to use a custom token consistently across
// the browser (vite-dev-token-plugin.ts) and this probe. When a custom value
// is set the spawned daemon receives an explicit --token flag that overrides
// the default baked into the pnpm script, keeping all three in sync.
const DEV_BEARER_TOKEN = resolveDevBearerToken(process.env)
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..', '..')
const LOG_DIR = join(REPO_ROOT, 'tmp', 'logs')
const LOG_PATH = join(LOG_DIR, 'mcp-http-dev.log')
const QUIET = process.argv.includes('--quiet')

function info(message) {
  if (!QUIET) console.log(message)
}

function probe(port) {
  // Try to occupy the port. If EADDRINUSE, something else is already there.
  return new Promise((resolveProbe) => {
    const tester = createServer()
    tester.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolveProbe('in-use')
      else resolveProbe('error')
    })
    tester.once('listening', () => tester.close(() => resolveProbe('free')))
    tester.listen(port, HOST)
  })
}

// Probe `/mcp` with the dev bearer token + a JSON-RPC initialize request.
// Confirms three things at once: (1) something is on the port, (2) it
// accepts our bearer (so .claude / .codex auth headers will succeed),
// (3) it speaks JSON-RPC (so it isn't an unrelated local service that
// happens to grab port 3099).
async function probeAuthenticatedMcpDaemon() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3_000)
  try {
    const res = await fetch(`http://${HOST}:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEV_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ensure-http-dev-daemon',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'ensure-http-dev-daemon', version: '0.0.0' },
        },
      }),
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) return 'wrong-token'
    if (!res.ok) return 'not-mcp'
    // Accept either application/json (synchronous response) or
    // text/event-stream (streamed transport). Anything else is some other
    // service answering 200 by coincidence.
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!ct.includes('application/json') && !ct.includes('text/event-stream')) {
      return 'not-mcp'
    }
    return 'ours'
  } catch {
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }
}

const status = await probe(PORT)
if (status === 'in-use') {
  // Something is on the port. It might be our dev daemon from a previous
  // session, an old whiteboard daemon spawned by the stdio path with a
  // different token, or an unrelated local service that grabbed 3099.
  // Treating any of these as "OK, keep going" silently breaks the next
  // MCP connection, so verify it's actually our authenticated daemon
  // before claiming success.
  const verdict = await probeAuthenticatedMcpDaemon()
  if (verdict === 'ours') {
    info(`[ensure-http-dev-daemon] http://${HOST}:${PORT} already listening — verified`)
    process.exit(0)
  }
  const why =
    verdict === 'wrong-token'
      ? 'rejected the dev bearer token (likely a stale daemon with a different token)'
      : verdict === 'not-mcp'
        ? 'is not speaking MCP'
        : 'did not respond to a probe'
  console.error(
    `[ensure-http-dev-daemon] http://${HOST}:${PORT} is in use but ${why}. ` +
      'Stop the conflicting process (e.g. `pkill -f mcp:http:dev`) and rerun.',
  )
  process.exit(1)
}

await mkdir(LOG_DIR, { recursive: true })
const logFile = await open(LOG_PATH, 'a')
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const child = spawn(pnpmCmd, buildMcpHttpDevSpawnArgs(DEV_BEARER_TOKEN), {
  cwd: REPO_ROOT,
  detached: true,
  stdio: ['ignore', logFile.fd, logFile.fd],
  env: process.env,
})
child.on('error', (err) => {
  console.error(`[ensure-http-dev-daemon] failed to spawn ${pnpmCmd}: ${err.message}`)
  process.exit(1)
})
await logFile.close()

// Wait for the daemon to actually accept connections before letting the
// hook return. Without this, an MCP client started right after the hook
// can race the daemon's bind and see ECONNREFUSED while the script
// reports success.
let exitedEarly = false
let exitCode = null
child.once('exit', (code) => {
  exitedEarly = true
  exitCode = code
})
const ready = await waitForAuthenticatedMcp({
  // A concurrent hook can win the bind race and make our child exit. Keep
  // probing until timeout because that competing process may still become the
  // healthy daemon this session needs.
  probe: probeAuthenticatedMcpDaemon,
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  timeoutMs: READY_TIMEOUT_MS,
  pollIntervalMs: READY_POLL_INTERVAL_MS,
})
if (!ready) {
  const detail = exitedEarly ? `; spawned process exited with code ${exitCode}` : ''
  console.error(
    `[ensure-http-dev-daemon] timed out waiting for authenticated MCP at http://${HOST}:${PORT} after ${READY_TIMEOUT_MS}ms${detail} — see ${LOG_PATH}`,
  )
  process.exit(1)
}

// Detach now that we know the daemon is up — keeps the parent shell free
// to disconnect without taking the child down with it.
child.unref()
info(
  `[ensure-http-dev-daemon] started ${pnpmCmd} mcp:http:dev (pid ${child.pid}) — log: ${LOG_PATH}`,
)
