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
// request (fresh server + transport, no Mcp-Session-Id): one line in = one
// POST, with no protocol session to lose across daemon restarts. Both
// protocol eras traverse it. A 2026-07-28 request names its revision in
// `params._meta`, and the endpoint refuses one whose standard headers
// (MCP-Protocol-Version, Mcp-Method, Mcp-Name) do not mirror the body, so
// those are derived from each line exactly as the SDK's HTTP client derives
// them. A reply that arrives as an SSE stream — a modern call whose `_meta`
// opts into log records, or a long-lived listen — is relayed message by
// message as each arrives, in order, so its `notifications/message` records
// reach the client ahead of the result and a stream that never ends still
// delivers.
// What does not traverse is anything the server sends OUTSIDE a request's
// reply (tools listChanged): there is no standing stream to carry it — a
// dev-only tradeoff; reload the client session to pick up a changed tool list.
//
// Requests go to the socket the daemon's record names (ADR-0050 decision 2),
// never to a port this derives: while there is no record — the daemon is
// starting, or is between the two halves of a watch restart — a request
// waits within its retry budget for one to appear — a Unix socket, or a named
// pipe on Windows.
//
// Env:
//   WHITEBOARD_DATA_DIR             where to read daemon.json (default: .dev-data)
//   WHITEBOARD_TOKEN                bearer token (default: whiteboard-dev)
//   WHITEBOARD_PROXY_SKIP_ENSURE=1  do not spawn the ensure hook (tests)
//   WHITEBOARD_PROXY_RETRY_TIMEOUT_MS  per-request retry budget (default 30000)
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/client'
import { readDaemonRecord, requestDaemon } from './dev-daemon-socket-lib.mjs'
import { resolveDevDataDirEnv, resolveRepoRootFromGit } from './with-dev-data-dir-lib.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolveRepoRootFromGit(SCRIPT_DIR)
const TOKEN = process.env.WHITEBOARD_TOKEN ?? 'whiteboard-dev'
const DATA_DIR = resolveDevDataDirEnv(process.env, REPO_ROOT).WHITEBOARD_DATA_DIR
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
    // Anchored on THIS checkout: the hook takes its checkout from
    // CLAUDE_PROJECT_DIR (before its working directory), and a session opened
    // in a linked worktree runs the main checkout's proxy — one registration
    // per repository — with CLAUDE_PROJECT_DIR naming the worktree. Left
    // inherited, the hook would start the worktree's daemon while every
    // request here reads the main checkout's record. WHITEBOARD_DATA_DIR,
    // when set, is inherited and wins on both sides alike.
    const hook = spawn(process.execPath, [resolve(SCRIPT_DIR, 'ensure-http-dev-daemon.mjs')], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    // The hook waiting out readiness is best-effort here: per-request retry
    // below is the real net, so a hook failure must not kill the proxy.
    hook.once('exit', () => resolveEnsure(undefined))
    hook.once('error', () => resolveEnsure(undefined))
  })
}

const ready = ensureDaemon()

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: `Bearer ${TOKEN}`,
}

// Which body field `Mcp-Name` mirrors, per method — the SDK's
// MCP_NAME_HEADER_SOURCE, which its public surface does not export. The
// script test holds this and `encodeHeaderValue` to the installed SDK client.
const MCP_NAME_SOURCE = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
  'tasks/get': 'taskId',
  'tasks/update': 'taskId',
  'tasks/cancel': 'taskId',
}

// A header value that is not plain printable ASCII travels as the spec's
// `=?base64?…?=` sentinel, which is what the server decodes before comparing.
function encodeHeaderValue(value) {
  const plain =
    value.length > 0 &&
    value === value.trim() &&
    !(value.startsWith('=?base64?') && value.endsWith('?=')) &&
    /^[\t\x20-\x7e]*$/.test(value)
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/**
 * The standard request headers a modern-era line needs, derived from the line
 * itself. A request with no protocol-version claim in its `_meta` is a 2025
 * exchange and gets none, so no modern header can reach a legacy request.
 */
function eraHeadersFor(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return {}
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return {}
  if (typeof message.method !== 'string' || !('id' in message)) return {}
  const params = message.params
  const version = params?._meta?.[PROTOCOL_VERSION_META_KEY]
  if (typeof version !== 'string') return {}
  const headers = { 'MCP-Protocol-Version': version, 'Mcp-Method': message.method }
  const field = Object.hasOwn(MCP_NAME_SOURCE, message.method)
    ? MCP_NAME_SOURCE[message.method]
    : undefined
  const name = field === undefined ? undefined : params?.[field]
  if (typeof name === 'string') headers['Mcp-Name'] = encodeHeaderValue(name)
  return headers
}

// The record is read per request, not once: a watch restart rewrites it, and
// a daemon that is down has none.
function post(line, onChunk) {
  const record = readDaemonRecord(DATA_DIR)
  if (record === null) return Promise.reject(new Error('the dev daemon has no record yet'))
  const headers = { ...MCP_HEADERS, ...eraHeadersFor(line) }
  return requestDaemon(record, { method: 'POST', path: '/mcp', headers, body: line, onChunk })
}

/**
 * Writes each `data:` message of a 2xx event stream to stdout the moment its
 * line is complete. A stream may never end (a long-lived listen), so waiting
 * for the end would hold every message it carries; and the records a call
 * emits come before its result, in order.
 */
function streamRelay() {
  let buffer = ''
  let wrote = false
  const onChunk = (chunk, { status, contentType }) => {
    if (status < 200 || status >= 300 || !contentType.includes('text/event-stream')) return
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.startsWith('data:')) continue
      const message = line.slice(5).trim()
      if (message === '') continue
      process.stdout.write(`${message}\n`)
      wrote = true
    }
  }
  return { onChunk, wrote: () => wrote }
}

async function forwardOnce(line) {
  const relay = streamRelay()
  let answer
  try {
    answer = await post(line, relay.onChunk)
  } catch (error) {
    // Part of the stream already reached the client: a retry would repeat it.
    if (relay.wrote()) error.nonRetryable = true
    throw error
  }
  const { status, contentType, text } = answer
  // 202/empty: a notification was accepted — nothing to write back.
  if (status === 202 || text.trim() === '') return null
  if ((status < 200 || status >= 300) && !isJson(text)) {
    // The daemon's own /mcp errors carry JSON-RPC bodies (a 401 does) and
    // are passed through below. A non-JSON error body is NOT a protocol
    // response — never write it to stdout. 5xx is treated as transient
    // (retried by the caller); anything else fails the request fast.
    const error = new Error(`HTTP ${status} from the daemon endpoint`)
    error.nonRetryable = status < 500
    throw error
  }
  // A 2xx event stream was written as it arrived (`streamRelay`).
  if (contentType.includes('text/event-stream')) return null
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
      const message = await forwardWithRetry(line)
      if (message !== null) process.stdout.write(`${message}\n`)
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

log(`proxying stdio <-> /mcp on the socket named in ${resolve(DATA_DIR, 'daemon.json')}`)
