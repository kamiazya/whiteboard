#!/usr/bin/env node
// Dev stdio -> HTTP proxy for the whiteboard MCP daemon.
//
// Why this exists: an MCP client (Claude Code / Codex) configured with a
// plain HTTP server attempts ONE connection at session start and never
// retries. The SessionStart hook spawns the dev daemon concurrently, so the
// client regularly loses that race and the whole session runs without the
// whiteboard tools; a tsx-watch restart mid-session strands it the same
// way. Registering THIS process as a stdio server instead makes the
// client-visible connection a local spawn that always succeeds, and moves
// both failure modes here, where they are absorbable:
//
// - on startup, the ensure-http-dev-daemon hook is run (same script the
//   SessionStart hook uses — idempotent, waits for readiness);
// - every stdin JSON-RPC line becomes one authenticated POST /mcp, and a
//   connection failure retries within a budget instead of surfacing.
//
// This is sound because the daemon's /mcp endpoint is stateless per
// request (fresh server + transport, no Mcp-Session-Id, JSON responses):
// one line in = one POST = one line out, with no protocol session to lose
// across daemon restarts. Server-initiated notifications (tools
// listChanged) don't traverse this proxy — a dev-only tradeoff; reload the
// client session to pick up a changed tool list.
//
// Env:
//   WHITEBOARD_DEV_PORT             override the derived port (tests)
//   WHITEBOARD_TOKEN                bearer token (default: whiteboard-dev)
//   WHITEBOARD_PROXY_SKIP_ENSURE=1  do not spawn the ensure hook (tests)
//   WHITEBOARD_PROXY_RETRY_TIMEOUT_MS  per-request retry budget (default 30000)
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { deriveDevPort, isMainCheckout } from './dev-port-lib.mjs'
import { resolveRepoRootFromGit } from './with-dev-data-dir-lib.mjs'

const HOST = '127.0.0.1'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolveRepoRootFromGit(SCRIPT_DIR)
const PORT = deriveDevPort({
  repoRoot: REPO_ROOT,
  isMainCheckout: isMainCheckout(REPO_ROOT),
  env: process.env,
})
const TOKEN = process.env.WHITEBOARD_TOKEN ?? 'whiteboard-dev'
const DEFAULT_RETRY_TIMEOUT_MS = 30_000

// Only a finite, non-negative override is usable: NaN or Infinity would make
// the per-request deadline unreachable, turning the retry loop into an
// infinite block against a daemon that never comes up.
function parseRetryTimeoutMs(raw) {
  if (raw === undefined) return DEFAULT_RETRY_TIMEOUT_MS
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed >= 0) return parsed
  log(
    `ignoring invalid WHITEBOARD_PROXY_RETRY_TIMEOUT_MS=${JSON.stringify(raw)}; using ${DEFAULT_RETRY_TIMEOUT_MS}`,
  )
  return DEFAULT_RETRY_TIMEOUT_MS
}

const RETRY_TIMEOUT_MS = parseRetryTimeoutMs(process.env.WHITEBOARD_PROXY_RETRY_TIMEOUT_MS)
const RETRY_INTERVAL_MS = 250

// stdout is the protocol channel — logs go to stderr only.
function log(message) {
  process.stderr.write(`[mcp-http-stdio-proxy] ${message}\n`)
}

function ensureDaemon() {
  if (process.env.WHITEBOARD_PROXY_SKIP_ENSURE === '1') return Promise.resolve()
  return new Promise((resolveEnsure) => {
    const hook = spawn(process.execPath, [resolve(SCRIPT_DIR, 'ensure-http-dev-daemon.mjs')], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    // The hook waiting out readiness is best-effort here: per-request retry
    // below is the real net, so a hook failure must not kill the proxy.
    hook.once('exit', () => resolveEnsure(undefined))
    hook.once('error', () => resolveEnsure(undefined))
  })
}

const ready = ensureDaemon()

async function forwardOnce(line) {
  const res = await fetch(`http://${HOST}:${PORT}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: line,
  })
  const contentType = res.headers.get('content-type')?.toLowerCase() ?? ''
  const text = await res.text()
  // 202/empty: a notification was accepted — nothing to write back.
  if (res.status === 202 || text.trim() === '') return null
  if (!res.ok && !isJson(text)) {
    // The daemon's own /mcp errors carry JSON-RPC bodies (a 401 does) and
    // are passed through below. A non-JSON error body is NOT a protocol
    // response — never write it to stdout. 5xx is treated as transient
    // (retried by the caller); anything else fails the request fast.
    const error = new Error(`HTTP ${res.status} from the daemon endpoint`)
    error.nonRetryable = res.status < 500
    throw error
  }
  if (contentType.includes('text/event-stream')) {
    // enableJsonResponse keeps POSTs JSON in practice; parse SSE defensively
    // so an unexpected stream reply still yields the final message.
    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((l) => l !== '')
    return dataLines.at(-1) ?? null
  }
  return text
}

function isJson(text) {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

async function forwardWithRetry(line) {
  const deadline = Date.now() + RETRY_TIMEOUT_MS
  let lastError
  for (;;) {
    try {
      return await forwardOnce(line)
    } catch (error) {
      lastError = error
      if (error?.nonRetryable === true) break
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS))
    }
  }
  throw lastError
}

function errorResponseFor(line, error) {
  let id = null
  try {
    const parsed = JSON.parse(line)
    if (parsed && typeof parsed === 'object' && 'id' in parsed) id = parsed.id
  } catch {
    // unparseable input — no id to correlate
  }
  if (id === null || id === undefined) return null
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: `dev daemon unreachable: ${String(error)}` },
  })
}

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
const inflight = new Set()

rl.on('line', (line) => {
  if (line.trim() === '') return
  const task = (async () => {
    await ready
    try {
      const response = await forwardWithRetry(line)
      if (response !== null) process.stdout.write(`${response}\n`)
    } catch (error) {
      log(`request failed after retries: ${String(error)}`)
      const errorResponse = errorResponseFor(line, error)
      if (errorResponse !== null) process.stdout.write(`${errorResponse}\n`)
    }
  })()
  inflight.add(task)
  void task.finally(() => inflight.delete(task))
})

rl.on('close', () => {
  // Client closed our stdin (session ended): drain and exit cleanly.
  void Promise.allSettled([...inflight]).then(() => process.exit(0))
})

log(`proxying stdio <-> http://${HOST}:${PORT}/mcp`)
