#!/usr/bin/env node
// End-to-end smoke test that runs through an MCP stdio subprocess.
//
// Purpose:
// Start the MCP server outside the parent client's context and verify that each
// OpenCanvas tool behaves according to spec using JSON-RPC stdio.
//
// Coverage:
//   1. tools/list matches the authoritative set in mcp-smoke-coverage.ts
//   2. wb_document_create → wb_facet_set → wb_version_save → wb_version_list → wb_version_restore
//
// This does not consume API quota, so it is safe in CI.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')
const tmpDataDir = mkdtempSync(`${tmpdir()}/whiteboard-e2e-`)
const entryArg = process.argv.find((arg) => arg.startsWith('--entry='))
const entry = resolve(
  root,
  entryArg ? entryArg.slice('--entry='.length) : 'src/server/mcp/index.ts',
)
const childArgs = entry.endsWith('.ts') ? ['--import', 'tsx/esm', entry] : [entry]

const child = spawn('node', childArgs, {
  cwd: root,
  env: { ...process.env, WHITEBOARD_DATA_DIR: tmpDataDir, WHITEBOARD_NO_WATCH: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stderrBuf = ''
child.stderr.on('data', (c) => {
  stderrBuf += c.toString()
})

const pending = new Map()
let stdoutBuf = Buffer.alloc(0)
child.stdout.on('data', (chunk) => {
  stdoutBuf = Buffer.concat([stdoutBuf, chunk])
  for (let idx = stdoutBuf.indexOf(0x0a); idx !== -1; idx = stdoutBuf.indexOf(0x0a)) {
    const line = stdoutBuf.subarray(0, idx).toString('utf-8')
    stdoutBuf = stdoutBuf.subarray(idx + 1)
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve: r, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`RPC ${msg.id}: ${JSON.stringify(msg.error)}`))
      else r(msg.result)
    }
  }
})

const RPC_TIMEOUT_MS = /^\d+$/.test(process.env.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS ?? '')
  ? Number(process.env.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS)
  : 20_000

let nextId = 1
function rpc(method, params) {
  const id = nextId++
  return new Promise((resolveRpc, reject) => {
    pending.set(id, { resolve: resolveRpc, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`RPC ${method} (#${id}) timed out`))
      }
    }, RPC_TIMEOUT_MS)
  })
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args })
  if (!res || !Array.isArray(res.content) || res.content[0]?.type !== 'text') {
    throw new Error(`unexpected tool/call result shape: ${JSON.stringify(res)}`)
  }
  const text = res.content[0].text
  if (res.isError) throw new Error(text)
  return JSON.parse(text)
}

async function expectToolError(name, args, because = 'without createWorkspace') {
  const res = await rpc('tools/call', { name, arguments: args })
  if (!res?.isError) {
    throw new Error(`expected ${name} to fail, got: ${JSON.stringify(res)}`)
  }
  console.log(`[e2e] ${name} ${because} → isError (expected)`)
}

function cleanup(exitCode) {
  try {
    child.kill('SIGTERM')
  } catch {}
  rmSync(tmpDataDir, { recursive: true, force: true })
  if (exitCode !== 0 && stderrBuf) {
    console.error(`\n--- MCP stderr ---\n${stderrBuf}\n--- end ---`)
  }
  process.exit(exitCode)
}

process.on('SIGINT', () => cleanup(130))

/** Workspace slug used for every canvas the smoke creates. */
const WORKSPACE_ID = 'e2e'

// Authoritative tool list — must match ALL_REGISTERED_TOOLS in mcp-smoke-coverage.ts.
const EXPECTED_TOOLS = [
  'wb_body_patch',
  'wb_scene_digest',
  'canvas_export_json_canvas',
  'canvas_export_okf',
  'wb_document_set',
  'wb_scene_render',
  'wb_edge_lock',
  'wb_edge_patch',
  'wb_facet_set',
  'wb_node_lock',
  'wb_node_patch',
  'wb_canvas_tidy',
  'wb_version_list',
  'wb_version_restore',
  'wb_version_save',
  'wb_document_create',
  'wb_document_delete',
  'wb_document_resolve',
  'wb_document_list',
]

async function main() {
  console.log(`[e2e] entry → ${entry}`)

  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-smoke', version: '0.0.0' },
  })
  notify('notifications/initialized', {})

  // tools/list: verify the exact set matches the authoritative list.
  const tools = await rpc('tools/list', {})
  const names = tools.tools.map((t) => t.name).sort()
  const expected = [...EXPECTED_TOOLS].sort()
  const inLiveNotExpected = names.filter((n) => !expected.includes(n))
  const inExpectedNotLive = expected.filter((n) => !names.includes(n))
  if (inLiveNotExpected.length > 0 || inExpectedNotLive.length > 0) {
    const lines = ['tools/list does not match expected tool set.']
    if (inLiveNotExpected.length > 0) {
      lines.push(`  In tools/list but not expected: ${inLiveNotExpected.join(', ')}`)
    }
    if (inExpectedNotLive.length > 0) {
      lines.push(`  Expected but not in tools/list: ${inExpectedNotLive.join(', ')}`)
    }
    throw new Error(lines.join('\n'))
  }
  console.log(`[e2e] tools/list → ${names.length} tools match expected set`)

  // Unknown-workspace guard: without createWorkspace the create must fail
  // (workspaces never materialize implicitly from a typo'd workspaceId).
  await expectToolError('wb_document_create', {
    workspaceId: WORKSPACE_ID,
    segment: 'e2e-src',
    kind: 'spatial',
  })

  // wb_document_create: first daemon-dependent RPC (cold-start latency).
  const created = await callTool('wb_document_create', {
    workspaceId: WORKSPACE_ID,
    segment: 'e2e-src',
    kind: 'spatial',
    createWorkspace: true,
  })
  if (typeof created.canvasId !== 'string' || created.segment !== 'e2e-src') {
    throw new Error(`wb_document_create returned unexpected shape: ${JSON.stringify(created)}`)
  }
  const canvasId = created.canvasId
  console.log(`[e2e] wb_document_create → ${canvasId}`)

  // wb_facet_set: seed extension-facet state so wb_version_save has content.
  const facets = await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    canvasId,
    facets: { 'e2e/1': { note: 'before-save' } },
  })
  if (facets.canvasId !== canvasId) {
    throw new Error(`wb_facet_set returned unexpected shape: ${JSON.stringify(facets)}`)
  }
  console.log('[e2e] wb_facet_set → seeded canvas state')

  // wb_node_lock: the sidecar lock round-trip. wb_document_set is the only
  // MCP path that creates a spatial node, and it always writes one text
  // node with this id.
  await callTool('wb_document_set', {
    workspaceId: WORKSPACE_ID,
    canvasId,
    markdown: '---\ntype: canvas\ntitle: e2e-lock\n---\n\nlockable body\n',
  })

  const nodeLocked = await callTool('wb_node_lock', {
    workspaceId: WORKSPACE_ID,
    canvasId,
    nodeId: 'okf-body',
    locked: true,
  })
  if (
    nodeLocked.canvasId !== canvasId ||
    nodeLocked.nodeId !== 'okf-body' ||
    nodeLocked.locked !== true
  ) {
    throw new Error(`wb_node_lock returned unexpected shape: ${JSON.stringify(nodeLocked)}`)
  }
  console.log('[e2e] wb_node_lock → okf-body locked')

  // The lock binds agents, not just the pointer.
  await expectToolError(
    'wb_node_patch',
    { workspaceId: WORKSPACE_ID, canvasId, nodeId: 'okf-body', patch: { x: 999 } },
    'on a locked node',
  )

  // The lock is editor state, never canvas content: it must not appear in
  // an export. This is the runtime guard for the sidecar-map contract.
  const exportedWithLocks = await callTool('canvas_export_json_canvas', {
    workspaceId: WORKSPACE_ID,
    canvasId,
  })
  const exportedCanvas = JSON.parse(exportedWithLocks.json)
  const leaked = [...exportedCanvas.nodes, ...exportedCanvas.edges].filter(
    (element) => 'locked' in element,
  )
  if (leaked.length > 0) {
    throw new Error(`a lock leaked into the JSON Canvas export: ${JSON.stringify(leaked)}`)
  }
  console.log('[e2e] canvas_export_json_canvas → no lock leaked into the export')

  await callTool('wb_node_lock', {
    workspaceId: WORKSPACE_ID,
    canvasId,
    nodeId: 'okf-body',
    locked: false,
  })

  // wb_canvas_tidy: the canvas holds a single node here, so the contract answer
  // is "nothing to tidy" — the call still runs the full pipeline (input
  // parse → doc load → tidy → structuredContent vs outputSchema), which is
  // the drift guard this smoke exists for. The geometry itself is covered by
  // canvas-render's unit/property tests.
  const tidied = await callTool('wb_canvas_tidy', {
    workspaceId: WORKSPACE_ID,
    canvasId,
  })
  if (tidied.canvasId !== canvasId || !Array.isArray(tidied.moved) || tidied.moved.length !== 0) {
    throw new Error(`wb_canvas_tidy returned unexpected shape: ${JSON.stringify(tidied)}`)
  }
  console.log('[e2e] wb_canvas_tidy → single-node canvas reports no moves')

  // wb_edge_lock reaches its ghost-id guard only: no MCP tool creates an edge
  // (edges come from the editor), so this is the whole of its reachable
  // surface here. Its success path is covered by edge-lock.test.ts.
  await expectToolError(
    'wb_edge_lock',
    { workspaceId: WORKSPACE_ID, canvasId, edgeId: 'no-such-edge', locked: true },
    'with an id the canvas does not have',
  )

  // wb_version_save
  const saved = await callTool('wb_version_save', {
    canvasId,
    label: 'e2e',
  })
  if (
    !saved.versionId ||
    saved.canvasId !== canvasId ||
    saved.label !== 'e2e' ||
    !saved.timestamp ||
    !saved.frontier
  ) {
    throw new Error(`wb_version_save returned unexpected shape: ${JSON.stringify(saved)}`)
  }
  console.log(`[e2e] wb_version_save → ${saved.versionId}`)

  // wb_version_list
  const listed = await callTool('wb_version_list', { canvasId })
  if (
    listed.canvasId !== canvasId ||
    !Array.isArray(listed.versions) ||
    !listed.versions.some((v) => v.versionId === saved.versionId)
  ) {
    throw new Error(`wb_version_list missing the saved id: ${JSON.stringify(listed)}`)
  }
  console.log(`[e2e] wb_version_list → ${listed.versions.length} version(s)`)

  // wb_version_restore
  const restored = await callTool('wb_version_restore', {
    workspaceId: WORKSPACE_ID,
    canvasId,
    versionId: saved.versionId,
  })
  if (
    restored.canvasId !== canvasId ||
    restored.restoredVersionId !== saved.versionId ||
    restored.label !== saved.label ||
    restored.frontier !== saved.frontier
  ) {
    throw new Error(`wb_version_restore returned unexpected shape: ${JSON.stringify(restored)}`)
  }
  console.log(`[e2e] wb_version_restore → ${restored.restoredVersionId}`)

  // wb_document_set → canvas_export_okf round-trip, including the core
  // facets (type/title/tags) — these are stored via writeCoreFacets, a
  // separate code path from the extension `facets` bucket below, so this is
  // the runtime guard for structuredContent-vs-outputSchema drift on both.
  const importMarkdown = [
    '---',
    'type: issue',
    'title: "Smoke test issue"',
    'tags:',
    '  - smoke',
    '  - e2e',
    'facets:',
    '  issue/1:',
    '    status: open',
    '---',
    'Imported body.',
  ].join('\n')
  const imported = await callTool('wb_document_set', {
    workspaceId: WORKSPACE_ID,
    canvasId,
    markdown: importMarkdown,
  })
  if (!imported.imported || imported.canvasId !== canvasId) {
    throw new Error(`wb_document_set returned unexpected shape: ${JSON.stringify(imported)}`)
  }
  console.log('[e2e] wb_document_set → imported')

  const exported = await callTool('canvas_export_okf', {
    workspaceId: WORKSPACE_ID,
    canvasId,
  })
  if (!exported.markdown.includes('Imported body.')) {
    throw new Error(`canvas_export_okf body mismatch after import: ${exported.markdown}`)
  }
  if (!exported.frontmatter.facets?.['issue/1']) {
    throw new Error(
      `canvas_export_okf facets missing after import: ${JSON.stringify(exported.frontmatter)}`,
    )
  }
  if (
    exported.frontmatter.type !== 'issue' ||
    exported.frontmatter.title !== 'Smoke test issue' ||
    JSON.stringify(exported.frontmatter.tags) !== JSON.stringify(['smoke', 'e2e'])
  ) {
    throw new Error(
      `canvas_export_okf core facets mismatch after import: ${JSON.stringify(exported.frontmatter)}`,
    )
  }
  console.log('[e2e] canvas_export_okf → round-trip verified (core facets + extension facets)')

  console.log('\n[e2e] ALL OK')
}

main().then(
  () => cleanup(0),
  (err) => {
    console.error(`[e2e] FAIL: ${err.message}`)
    cleanup(1)
  },
)
