#!/usr/bin/env node

// Flagship end-to-end regression for the identity-convergence initiative's
// own acceptance bar: create a document via a real MCP tool call, edit it
// through the exact WS transport apps/web executes (real subprotocol auth,
// real binary Loro update frames built by loro-adapter's writeSpatialNode),
// and read it back via MCP — against a real spawned HTTP daemon, no mocks.
//
// This is the drift-bug shape (issue 1) plus the merge-before-save
// acceptance (mergeAndSaveSnapshotLocked in document-store.ts): an MCP
// write that lands while a WS session is holding a stale cached doc must
// still survive that WS session's next save.
//
// Env knobs (all optional):
//   WHITEBOARD_SMOKE_READY_TIMEOUT_MS        daemon readiness budget (default 30000)
//   WHITEBOARD_SMOKE_RPC_TIMEOUT_MS           per-RPC budget (default 20000)
//   WHITEBOARD_SMOKE_CONVERGENCE_TIMEOUT_MS   wb_canvas_snapshot poll budget (default 10000)
//   WHITEBOARD_SMOKE_WS_SNAPSHOT_TIMEOUT_MS   WS initial-snapshot wait budget (default 20000)

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSpatialCanvas, writeSpatialNode } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { WebSocket } from 'ws'
import { documentApiUrl } from '../../src/shared/api-contracts/document-url.js'
import { buildWhiteboardWsProtocols, buildWhiteboardWsUrl } from '../../src/shared/ws-protocol.js'
import { waitForEventWithTimeout } from './lib/wait-for-event.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

const WORKSPACE_ID = 'conv-e2e'
const DOCUMENT_PATH = 'conv-e2e-doc'

const READY_TIMEOUT_MS = /^\d+$/.test(process.env.WHITEBOARD_SMOKE_READY_TIMEOUT_MS ?? '')
  ? Number(process.env.WHITEBOARD_SMOKE_READY_TIMEOUT_MS)
  : 30_000
const READY_POLL_INTERVAL_MS = 250
const RPC_TIMEOUT_MS = /^\d+$/.test(process.env.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS ?? '')
  ? Number(process.env.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS)
  : 20_000
const CONVERGENCE_TIMEOUT_MS = /^\d+$/.test(
  process.env.WHITEBOARD_SMOKE_CONVERGENCE_TIMEOUT_MS ?? '',
)
  ? Number(process.env.WHITEBOARD_SMOKE_CONVERGENCE_TIMEOUT_MS)
  : 10_000
const CONVERGENCE_POLL_INTERVAL_MS = 200
const WS_SNAPSHOT_TIMEOUT_MS = /^\d+$/.test(
  process.env.WHITEBOARD_SMOKE_WS_SNAPSHOT_TIMEOUT_MS ?? '',
)
  ? Number(process.env.WHITEBOARD_SMOKE_WS_SNAPSHOT_TIMEOUT_MS)
  : 20_000

// Generated fresh per run and passed to the daemon ONLY via child env
// (WHITEBOARD_TOKEN) — never as a --token argv flag, so it is invisible to
// process listings and to the spawn-args line this script itself logs.
const TOKEN = randomBytes(24).toString('hex')

// Every line this script emits — its own progress logs and the daemon
// stderr dump on failure — funnels through here first. A token appearing in
// anything about to be printed is treated as a bug: refuse to print it and
// fail loudly with a message that itself never contains the token.
function assertNoTokenLeak(text) {
  if (text.includes(TOKEN)) {
    throw new Error('token leaked into output')
  }
}

function log(message) {
  assertNoTokenLeak(message)
  console.log(message)
}

// Same funnel as log(), for the error-reporting paths (WS errors, the
// top-level rejection handler) that print to stderr instead of stdout.
function logError(message) {
  try {
    assertNoTokenLeak(message)
    console.error(message)
  } catch {
    console.error('[e2e] error message suppressed: token leaked into output')
  }
}

function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer()
    probe.once('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolvePort(address.port))
    })
  })
}

const tmpDataDir = mkdtempSync(`${tmpdir()}/whiteboard-convergence-e2e-`)
const port = await getFreePort()
const mcpUrl = `http://127.0.0.1:${port}/mcp`
const entry = resolve(root, 'src/server/index.ts')
// No --daemon: this is a throwaway per-run server, not a registered
// long-lived daemon — --daemon would also write a daemon-registry record
// under the real home dir, which this smoke has no business touching.
const childArgs = ['--import', 'tsx/esm', entry, `--port=${port}`, '--idle-timeout-ms=0']

log(
  `[e2e] spawn → node ${childArgs.join(' ')} (dataDir=${tmpDataDir}; token via env only, not shown)`,
)

const child = spawn('node', childArgs, {
  cwd: root,
  // WHITEBOARD_TOKEN is the only place the token reaches the child.
  env: { ...process.env, WHITEBOARD_DATA_DIR: tmpDataDir, WHITEBOARD_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stderrBuf = ''
child.stderr.on('data', (c) => {
  stderrBuf += c.toString()
})
child.stdout.on('data', () => {
  // Drained but unused: readiness is decided by the authenticated /mcp
  // probe below, not by the process's own "READY" stdout line.
})

function cleanup(exitCode) {
  try {
    child.kill('SIGTERM')
  } catch {}
  rmSync(tmpDataDir, { recursive: true, force: true })
  if (exitCode !== 0 && stderrBuf) {
    try {
      assertNoTokenLeak(stderrBuf)
      console.error(`\n--- daemon stderr ---\n${stderrBuf}\n--- end ---`)
    } catch {
      console.error('\n[e2e] daemon stderr suppressed: token leaked into output\n')
    }
  }
  process.exit(exitCode)
}
process.on('SIGINT', () => cleanup(130))
process.on('SIGTERM', () => cleanup(143))

let nextId = 1

async function rpc(method, params) {
  const id = nextId++
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  let res
  try {
    res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error(
      `RPC ${method}: daemon rejected our own bearer token (HTTP ${res.status})`,
    )
    err.nonRetryable = true
    throw err
  }
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`RPC ${method} HTTP ${res.status}: ${text.slice(0, 500)}`)
  }
  let payload
  if (contentType.includes('text/event-stream')) {
    // enableJsonResponse keeps POSTs JSON in practice; parse SSE defensively
    // so an unexpected stream reply still yields the final message.
    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((l) => l !== '')
    payload = JSON.parse(dataLines.at(-1) ?? '{}')
  } else {
    payload = JSON.parse(text)
  }
  if (payload.error) throw new Error(`RPC ${method}: ${JSON.stringify(payload.error)}`)
  return payload.result
}

async function notify(method, params) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  try {
    return await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args })
  if (!res || !Array.isArray(res.content) || res.content[0]?.type !== 'text') {
    throw new Error(`unexpected tools/call result shape for ${name}: ${JSON.stringify(res)}`)
  }
  const text = res.content[0].text
  if (res.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text)
}

// Polls the authenticated /mcp initialize handshake until it succeeds
// (modeled on ensure-http-dev-daemon.mjs's probeAuthenticatedMcpDaemon).
// This IS the real handshake, not a throwaway probe — its result is
// returned so the caller does not have to send `initialize` a second time.
async function waitForReadyAndInitialize() {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError
  for (;;) {
    try {
      return await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'convergence-e2e-smoke', version: '0.0.0' },
      })
    } catch (err) {
      if (err?.nonRetryable) throw err
      lastError = err instanceof Error ? err.message : String(err)
      if (Date.now() >= deadline) {
        throw new Error(
          `daemon did not become ready within ${READY_TIMEOUT_MS}ms (last: ${lastError})`,
        )
      }
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS))
    }
  }
}

async function main() {
  await waitForReadyAndInitialize()
  log(`[e2e] daemon ready → ${mcpUrl}`)
  await notify('notifications/initialized', {})

  // ── Step 2: real MCP tool calls create a spatial document with known content ──
  const created = await callTool('wb_document_create', {
    workspaceId: WORKSPACE_ID,
    path: DOCUMENT_PATH,
    kind: 'spatial',
    createWorkspace: true,
  })
  if (typeof created.documentId !== 'string') {
    throw new Error(`wb_document_create returned unexpected shape: ${JSON.stringify(created)}`)
  }
  const documentId = created.documentId
  log(`[e2e] wb_document_create → ${documentId}`)

  const NODE_A = {
    id: 'node-a',
    type: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    text: 'node A — created via MCP',
  }
  const addedA = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    ops: [{ op: 'node.add', node: NODE_A }],
  })
  if (!addedA.touched?.nodes.includes('node-a')) {
    throw new Error(`wb_canvas_edit(A) returned unexpected shape: ${JSON.stringify(addedA)}`)
  }
  log('[e2e] wb_canvas_edit → node A')

  // ── Step 3: read the SAME document with no mocks through the HTTP path-
  //    snapshot route and the WS route — the exact shape of the drift bug ──
  const snapshotRes = await fetch(
    `http://127.0.0.1:${port}${documentApiUrl(WORKSPACE_ID, DOCUMENT_PATH, 'snapshot')}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  )
  if (!snapshotRes.ok) {
    throw new Error(`HTTP path-snapshot failed: HTTP ${snapshotRes.status}`)
  }
  const httpSnapshotBytes = new Uint8Array(await snapshotRes.arrayBuffer())
  const httpDoc = new LoroDoc()
  httpDoc.import(httpSnapshotBytes)
  const httpCanvas = readSpatialCanvas(httpDoc)
  const nodeAViaHttp = httpCanvas.nodes.find((n) => n.id === 'node-a')
  if (nodeAViaHttp?.text !== NODE_A.text) {
    throw new Error(`HTTP path-snapshot missing/mismatched node A: ${JSON.stringify(nodeAViaHttp)}`)
  }
  log('[e2e] HTTP path-snapshot → node A present with exact content')

  const wsUrl = buildWhiteboardWsUrl(mcpUrl, WORKSPACE_ID, DOCUMENT_PATH)
  const ws = new WebSocket(wsUrl, buildWhiteboardWsProtocols(TOKEN))
  // Long-lived for the whole WS lifetime (initial snapshot, the later push,
  // and close) — not scoped to the snapshot wait — so a socket error any
  // time after the snapshot arrives is reported through the script's own
  // token-safe path instead of throwing uncaught and skipping cleanup().
  ws.on('error', (err) => {
    logError(`[e2e] WS error: ${err instanceof Error ? err.message : String(err)}`)
    cleanup(1)
  })
  const wsSnapshotData = await waitForEventWithTimeout(
    ws,
    'message',
    WS_SNAPSHOT_TIMEOUT_MS,
    `WS did not send the initial snapshot within ${WS_SNAPSHOT_TIMEOUT_MS}ms`,
  )
  const wsSnapshotBytes = new Uint8Array(wsSnapshotData)
  const wsDoc = new LoroDoc()
  wsDoc.import(wsSnapshotBytes)
  const nodeAViaWs = readSpatialCanvas(wsDoc).nodes.find((n) => n.id === 'node-a')
  if (nodeAViaWs?.text !== NODE_A.text) {
    throw new Error(`WS initial snapshot missing/mismatched node A: ${JSON.stringify(nodeAViaWs)}`)
  }
  log('[e2e] WS connect → initial snapshot contains node A')

  // ── Step 4: merge-before-save — one more MCP write (store-direct) lands
  //    while the WS session's doc-cache entry is still pinned to the doc it
  //    had at connect time, THEN the WS session pushes its own edit ──
  const NODE_C = {
    id: 'node-c',
    type: 'text',
    x: 800,
    y: 800,
    width: 200,
    height: 100,
    text: 'node C — added via MCP while the WS session is open',
  }
  const addedC = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    ops: [{ op: 'node.add', node: NODE_C }],
  })
  if (!addedC.touched?.nodes.includes('node-c')) {
    throw new Error(`wb_canvas_edit(C) returned unexpected shape: ${JSON.stringify(addedC)}`)
  }
  log('[e2e] wb_canvas_edit → node C (while WS session stays open)')

  // web-edit shape: import the connect-time snapshot into a fresh LoroDoc,
  // write a node through loro-adapter's writeSpatialNode (the same bridge
  // apps/web's editor calls), commit, export an incremental update relative
  // to the pre-edit version, and push it as one binary frame.
  const clientDoc = new LoroDoc()
  clientDoc.import(wsSnapshotBytes)
  const preEditVersion = clientDoc.version()
  const NODE_B = {
    id: 'node-b',
    type: 'text',
    x: 400,
    y: 400,
    width: 200,
    height: 100,
    text: 'node B — added over WS (web-edit shape)',
  }
  writeSpatialNode(clientDoc, NODE_B)
  const update = clientDoc.export({ mode: 'update', from: preEditVersion })
  ws.send(Buffer.from(update))
  log('[e2e] WS push → node B (writeSpatialNode + incremental update frame)')

  // ── Step 5: acceptance — MCP read-back names and contains all three
  //    writers' content. wb_canvas_snapshot is polled because the WS push
  //    above is fire-and-forget from the client's perspective. ──
  const expectedIds = ['node-a', 'node-b', 'node-c']
  const readDeadline = Date.now() + CONVERGENCE_TIMEOUT_MS
  for (;;) {
    const read = await callTool('wb_canvas_snapshot', { workspaceId: WORKSPACE_ID, documentId })
    const ids = new Set((read.nodes ?? []).map((n) => n.id))
    const missing = expectedIds.filter((id) => !ids.has(id))
    if (missing.length === 0) break
    if (Date.now() >= readDeadline) {
      throw new Error(
        `wb_canvas_snapshot did not converge within ${CONVERGENCE_TIMEOUT_MS}ms; still missing: ${missing.join(', ')}`,
      )
    }
    await new Promise((r) => setTimeout(r, CONVERGENCE_POLL_INTERVAL_MS))
  }
  log('[e2e] wb_canvas_snapshot → nodes A, B, C all named by id')

  const got = await callTool('wb_document_get', { workspaceId: WORKSPACE_ID, documentId })
  const exportedCanvas = JSON.parse(got.content)
  for (const node of [NODE_A, NODE_B, NODE_C]) {
    const found = exportedCanvas.nodes.find((n) => n.id === node.id)
    if (found?.text !== node.text) {
      throw new Error(
        `wb_document_get: node ${node.id} missing or content mismatch — a writer's ops were lost: ${JSON.stringify(found)}`,
      )
    }
  }
  log(
    '[e2e] wb_document_get → all three writers survive byte-level (MCP write, WS write, MCP write)',
  )

  ws.close()
  log('\n[e2e] ALL OK')
}

main().then(
  () => cleanup(0),
  (err) => {
    logError(`[e2e] FAIL: ${err instanceof Error ? err.message : String(err)}`)
    cleanup(1)
  },
)
