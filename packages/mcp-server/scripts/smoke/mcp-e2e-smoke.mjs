#!/usr/bin/env node
// End-to-end smoke test that runs through an MCP stdio subprocess.
//
// Purpose:
// Start the MCP server outside the parent client's context and verify that each
// document tool behaves according to spec using JSON-RPC stdio.
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

/**
 * `expecting` is required, and checked against the error text: isError alone
 * says a call failed, not that it failed for the reason under test. Every
 * step here refuses on a guard, and a typo'd id or an unrelated regression
 * also produces isError — which would keep the step green while testing
 * nothing.
 */
async function expectToolError(name, args, because, expecting) {
  const res = await rpc('tools/call', { name, arguments: args })
  if (!res?.isError) {
    throw new Error(`expected ${name} to fail, got: ${JSON.stringify(res)}`)
  }
  const text = res.content?.[0]?.text ?? ''
  if (!text.includes(expecting)) {
    throw new Error(
      `${name} failed for the wrong reason.\n  expected text containing: ${expecting}\n  got: ${text}`,
    )
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

/** Workspace path used for every canvas the smoke creates. */
const WORKSPACE_ID = 'e2e'

// Authoritative tool list — must match ALL_REGISTERED_TOOLS in mcp-smoke-coverage.ts.
const EXPECTED_TOOLS = [
  'wb_body_patch',
  'wb_scene_digest',
  'wb_document_get',
  'wb_document_set',
  'wb_scene_render',
  'canvas_view',
  'wb_edge_add',
  'wb_edge_lock',
  'wb_edge_patch',
  'wb_facet_set',
  'wb_node_add',
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
  await expectToolError(
    'wb_document_create',
    { workspaceId: WORKSPACE_ID, path: 'e2e-src', kind: 'spatial' },
    'without createWorkspace',
    'Workspace not found',
  )

  // wb_document_create: first daemon-dependent RPC (cold-start latency).
  const created = await callTool('wb_document_create', {
    workspaceId: WORKSPACE_ID,
    path: 'e2e-src',
    kind: 'spatial',
    createWorkspace: true,
  })
  if (typeof created.documentId !== 'string' || created.path !== 'e2e-src') {
    throw new Error(`wb_document_create returned unexpected shape: ${JSON.stringify(created)}`)
  }
  const documentId = created.documentId
  console.log(`[e2e] wb_document_create → ${documentId}`)

  // A document's name is the workspace's, not its content's (ADR-0009), so
  // it round-trips through create -> list without any document read.
  const named = await callTool('wb_document_create', {
    workspaceId: WORKSPACE_ID,
    path: 'e2e-named',
    kind: 'markdown',
    name: 'リリース計画 2026 / v2',
  })
  const namedList = await callTool('wb_document_list', { workspaceId: WORKSPACE_ID })
  const namedRow = namedList.canvases.find((c) => c.documentId === named.documentId)
  if (namedRow?.name !== 'リリース計画 2026 / v2') {
    throw new Error(`wb_document_list lost the document name: ${JSON.stringify(namedRow)}`)
  }
  const unnamedRow = namedList.canvases.find((c) => c.documentId === documentId)
  if (unnamedRow === undefined || 'name' in unnamedRow) {
    throw new Error(`an unnamed document should carry no name: ${JSON.stringify(unnamedRow)}`)
  }
  console.log('[e2e] wb_document_create/list → name round-trips, unnamed stays unnamed')

  // A facet is OKF frontmatter, so it belongs to the markdown document; the
  // spatial one refuses it.
  const facets = await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentId: named.documentId,
    facets: { 'e2e/1': { note: 'before-save' } },
  })
  if (facets.documentId !== named.documentId) {
    throw new Error(`wb_facet_set returned unexpected shape: ${JSON.stringify(facets)}`)
  }
  console.log('[e2e] wb_facet_set → set on the markdown document')

  await expectToolError(
    'wb_facet_set',
    { workspaceId: WORKSPACE_ID, documentId, facets: { 'e2e/1': { note: 'nope' } } },
    'on a spatial document',
    'Facets are OKF frontmatter',
  )

  // wb_node_add: the only MCP path that puts a node on a spatial canvas,
  // and what the lock round-trip below needs to have something to lock.
  const added = await callTool('wb_node_add', {
    workspaceId: WORKSPACE_ID,
    documentId,
    node: { id: 'lockable', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'lockable' },
  })
  if (added.documentId !== documentId || added.node?.id !== 'lockable') {
    throw new Error(`wb_node_add returned unexpected shape: ${JSON.stringify(added)}`)
  }
  console.log('[e2e] wb_node_add → lockable')

  await expectToolError(
    'wb_node_add',
    {
      workspaceId: WORKSPACE_ID,
      documentId,
      node: { id: 'lockable', type: 'text', x: 1, y: 1, width: 10, height: 10, text: 'clobber' },
    },
    'on an id that is already taken',
    'already exists on canvas',
  )

  // wb_edge_add: the only MCP path that connects two nodes. Needs a second
  // node, so it also proves wb_node_add adds rather than replaces.
  await callTool('wb_node_add', {
    workspaceId: WORKSPACE_ID,
    documentId,
    node: { id: 'target', type: 'text', x: 300, y: 0, width: 200, height: 100, text: 'target' },
  })
  const linked = await callTool('wb_edge_add', {
    workspaceId: WORKSPACE_ID,
    documentId,
    edge: { id: 'link', fromNode: 'lockable', toNode: 'target' },
  })
  if (linked.edge?.id !== 'link') {
    throw new Error(`wb_edge_add returned unexpected shape: ${JSON.stringify(linked)}`)
  }
  console.log('[e2e] wb_edge_add → lockable→target')

  // spatialCanvasSchema owns endpoint existence, so a dangling edge is
  // refused by the same gate a retarget goes through.
  await expectToolError(
    'wb_edge_add',
    {
      workspaceId: WORKSPACE_ID,
      documentId,
      edge: { id: 'dangling', fromNode: 'lockable', toNode: 'ghost' },
    },
    'with an endpoint the canvas does not have',
    'references nonexistent toNode',
  )

  const nodeLocked = await callTool('wb_node_lock', {
    workspaceId: WORKSPACE_ID,
    documentId,
    nodeId: 'lockable',
    locked: true,
  })
  if (
    nodeLocked.documentId !== documentId ||
    nodeLocked.nodeId !== 'lockable' ||
    nodeLocked.locked !== true
  ) {
    throw new Error(`wb_node_lock returned unexpected shape: ${JSON.stringify(nodeLocked)}`)
  }
  console.log('[e2e] wb_node_lock → lockable locked')

  // The lock binds agents, not just the pointer.
  await expectToolError(
    'wb_node_patch',
    { workspaceId: WORKSPACE_ID, documentId, nodeId: 'lockable', patch: { x: 999 } },
    'on a locked node',
    'node is locked',
  )

  // The lock is editor state, never canvas content: it must not appear in
  // an export. This is the runtime guard for the sidecar-map contract.
  const exportedWithLocks = await callTool('wb_document_get', {
    workspaceId: WORKSPACE_ID,
    documentId,
  })
  const exportedCanvas = JSON.parse(exportedWithLocks.content)
  const leaked = [...exportedCanvas.nodes, ...exportedCanvas.edges].filter(
    (element) => 'locked' in element,
  )
  if (leaked.length > 0) {
    throw new Error(`a lock leaked into the JSON Canvas export: ${JSON.stringify(leaked)}`)
  }
  console.log('[e2e] wb_document_get → no lock leaked into the spatial export')

  await callTool('wb_node_lock', {
    workspaceId: WORKSPACE_ID,
    documentId,
    nodeId: 'lockable',
    locked: false,
  })

  // wb_scene_render / wb_scene_digest: the only two tools whose
  // structuredContent is built through server-core's layoutSpatialCanvas
  // delegate (compose-canvas-scene.ts) rather than read back from stored
  // content — this is the runtime guard that the laid-out scene still
  // validates against canvasRenderSvgOutputSchema / sceneDigestSchema
  // through the real MCP SDK, which a type-level check cannot see.
  const rendered = await callTool('wb_scene_render', { workspaceId: WORKSPACE_ID, documentId })
  if (typeof rendered.svg !== 'string' || !rendered.svg.includes('<rect')) {
    throw new Error(`wb_scene_render returned unexpected shape: ${JSON.stringify(rendered)}`)
  }
  console.log('[e2e] wb_scene_render → svg with chrome for the seeded text node')

  // The opt-in reference path is a SECOND composition through the same
  // output schema, reached only when `embedReferences` is set — so the
  // default call above cannot cover it. This canvas has no file node, which
  // is the point: the resolve step must be a no-op that still produces a
  // schema-valid scene rather than something only exercised when a
  // reference happens to resolve.
  const renderedWithRefs = await callTool('wb_scene_render', {
    workspaceId: WORKSPACE_ID,
    documentId,
    embedReferences: true,
  })
  if (typeof renderedWithRefs.svg !== 'string' || !renderedWithRefs.svg.includes('<rect')) {
    throw new Error(
      `wb_scene_render(embedReferences) returned unexpected shape: ${JSON.stringify(renderedWithRefs)}`,
    )
  }
  console.log('[e2e] wb_scene_render(embedReferences:true) → schema-valid svg')

  // canvas_view is the MCP Apps UI tool: its payload is consumed by the
  // widget rather than by a model, and it is the only tool whose result
  // carries a `references` map. The SDK validates that map against
  // canvasViewOutputSchema (mdastRootSchema inside), so this call is the
  // runtime guard on a schema a type check cannot see through.
  const viewed = await callTool('canvas_view', { workspaceId: WORKSPACE_ID, documentId })
  if (viewed.documentId !== documentId) {
    throw new Error(`canvas_view echoed the wrong documentId: ${JSON.stringify(viewed)}`)
  }
  if (!Array.isArray(viewed.scene?.nodes) || typeof viewed.references !== 'object') {
    throw new Error(`canvas_view returned unexpected shape: ${JSON.stringify(viewed)}`)
  }
  console.log('[e2e] canvas_view → scene + references for the widget')

  const digest = await callTool('wb_scene_digest', { workspaceId: WORKSPACE_ID, documentId })
  if (!Array.isArray(digest.nodes) || digest.nodes.length === 0) {
    throw new Error(`wb_scene_digest returned unexpected shape: ${JSON.stringify(digest)}`)
  }
  // The names have to be the ones the OTHER tools take. A digest that reads
  // back positionally still satisfies the schema and still looks right in a
  // unit test, while telling a reader to patch a node that does not exist.
  if (!digest.nodes.some((node) => node.id === 'lockable')) {
    throw new Error(
      `wb_scene_digest did not name the seeded node by its document id: ${JSON.stringify(digest.nodes)}`,
    )
  }
  console.log('[e2e] wb_scene_digest → digest naming the seeded node by document id')

  // wb_canvas_tidy: what this asserts is the full pipeline (input parse →
  // doc load → tidy → structuredContent vs outputSchema), which is the drift
  // guard this smoke exists for. How far anything moves is geometry, covered
  // by canvas-render's unit/property tests — so this checks the shape of
  // every entry rather than a move count, which would only be restating the
  // layout the nodes above happen to have.
  const tidied = await callTool('wb_canvas_tidy', {
    workspaceId: WORKSPACE_ID,
    documentId,
  })
  if (
    tidied.documentId !== documentId ||
    !Array.isArray(tidied.moved) ||
    tidied.moved.some(
      (m) => typeof m.id !== 'string' || typeof m.x !== 'number' || typeof m.y !== 'number',
    )
  ) {
    throw new Error(`wb_canvas_tidy returned unexpected shape: ${JSON.stringify(tidied)}`)
  }
  console.log(`[e2e] wb_canvas_tidy → ${tidied.moved.length} move(s), each well-formed`)

  const edgeLocked = await callTool('wb_edge_lock', {
    workspaceId: WORKSPACE_ID,
    documentId,
    edgeId: 'link',
    locked: true,
  })
  if (edgeLocked.edgeId !== 'link' || edgeLocked.locked !== true) {
    throw new Error(`wb_edge_lock returned unexpected shape: ${JSON.stringify(edgeLocked)}`)
  }
  console.log('[e2e] wb_edge_lock → link locked')

  await expectToolError(
    'wb_edge_patch',
    { workspaceId: WORKSPACE_ID, documentId, edgeId: 'link', patch: { label: 'nope' } },
    'on a locked edge',
    'edge is locked',
  )

  await expectToolError(
    'wb_edge_lock',
    { workspaceId: WORKSPACE_ID, documentId, edgeId: 'no-such-edge', locked: true },
    'with an id the canvas does not have',
    'edge not found',
  )

  // wb_version_save
  const saved = await callTool('wb_version_save', {
    documentId,
    label: 'e2e',
  })
  if (
    !saved.versionId ||
    saved.documentId !== documentId ||
    saved.label !== 'e2e' ||
    !saved.timestamp ||
    !saved.frontier
  ) {
    throw new Error(`wb_version_save returned unexpected shape: ${JSON.stringify(saved)}`)
  }
  console.log(`[e2e] wb_version_save → ${saved.versionId}`)

  // wb_version_list
  const listed = await callTool('wb_version_list', { documentId })
  if (
    listed.documentId !== documentId ||
    !Array.isArray(listed.versions) ||
    !listed.versions.some((v) => v.versionId === saved.versionId)
  ) {
    throw new Error(`wb_version_list missing the saved id: ${JSON.stringify(listed)}`)
  }
  console.log(`[e2e] wb_version_list → ${listed.versions.length} version(s)`)

  // wb_version_restore
  const restored = await callTool('wb_version_restore', {
    workspaceId: WORKSPACE_ID,
    documentId,
    versionId: saved.versionId,
  })
  if (
    restored.documentId !== documentId ||
    restored.restoredVersionId !== saved.versionId ||
    restored.label !== saved.label ||
    restored.frontier !== saved.frontier
  ) {
    throw new Error(`wb_version_restore returned unexpected shape: ${JSON.stringify(restored)}`)
  }
  console.log(`[e2e] wb_version_restore → ${restored.restoredVersionId}`)

  // wb_document_set → wb_document_get round-trip, including the core
  // facets (type/title/tags) — these are stored via writeCoreFacets, a
  // separate code path from the extension `facets` bucket below, so this is
  // the runtime guard for structuredContent-vs-outputSchema drift on both.
  // A MARKDOWN document for the OKF round-trip. The spatial one above reads
  // back as JSON Canvas now, so asking it for frontmatter would be asking a
  // diagram for its markdown — exactly what wb_document_get stopped doing.
  const mdCreated = await callTool('wb_document_create', {
    workspaceId: WORKSPACE_ID,
    path: 'e2e-okf',
    kind: 'markdown',
  })
  const mdCanvasId = mdCreated.documentId

  // A write in the format the document is not in destroys rather than
  // fails: OKF into the spatial one replaces its nodes, a node into the
  // markdown one lands beside the text node holding its body.
  await expectToolError(
    'wb_document_set',
    { workspaceId: WORKSPACE_ID, documentId, markdown: '---\ntype: note\n---\nBody.' },
    'on a spatial document',
    'This writes OKF Markdown',
  )
  await expectToolError(
    'wb_node_add',
    {
      workspaceId: WORKSPACE_ID,
      documentId: mdCanvasId,
      node: { id: 'stray', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'stray' },
    },
    'on a markdown document',
    'This adds a JSON Canvas node',
  )

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
    documentId: mdCanvasId,
    markdown: importMarkdown,
  })
  if (!imported.imported || imported.documentId !== mdCanvasId) {
    throw new Error(`wb_document_set returned unexpected shape: ${JSON.stringify(imported)}`)
  }
  console.log('[e2e] wb_document_set → imported')

  const exported = await callTool('wb_document_get', {
    workspaceId: WORKSPACE_ID,
    documentId: mdCanvasId,
  })
  if (!exported.content.includes('Imported body.')) {
    throw new Error(`canvas_export_okf body mismatch after import: ${exported.content}`)
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
  console.log('[e2e] wb_document_get → round-trip verified (core facets + extension facets)')

  console.log('\n[e2e] ALL OK')
}

main().then(
  () => cleanup(0),
  (err) => {
    console.error(`[e2e] FAIL: ${err.message}`)
    cleanup(1)
  },
)
