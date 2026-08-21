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
  'wb_viewport_set',
  'wb_body_patch',
  'wb_canvas_snapshot',
  'wb_canvas_edit',
  'wb_document_get',
  'wb_document_set',
  'wb_scene_render',
  'canvas_view',
  'wb_facet_set',
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
  const namedRow = namedList.documents.find((c) => c.documentId === named.documentId)
  if (namedRow?.name !== 'リリース計画 2026 / v2') {
    throw new Error(`wb_document_list lost the document name: ${JSON.stringify(namedRow)}`)
  }
  const unnamedRow = namedList.documents.find((c) => c.documentId === documentId)
  if (unnamedRow === undefined || 'name' in unnamedRow) {
    throw new Error(`an unnamed document should carry no name: ${JSON.stringify(unnamedRow)}`)
  }
  console.log('[e2e] wb_document_create/list → name round-trips, unnamed stays unnamed')

  // A facet is OKF frontmatter, so it belongs to the markdown document; the
  // spatial one refuses it.
  const facets = await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentId: named.documentId,
    facets: { 'e2e.check/v1': { note: 'before-save' } },
  })
  if (facets.documentId !== named.documentId) {
    throw new Error(`wb_facet_set returned unexpected shape: ${JSON.stringify(facets)}`)
  }
  console.log('[e2e] wb_facet_set → set on the markdown document')

  await expectToolError(
    'wb_facet_set',
    { workspaceId: WORKSPACE_ID, documentId, facets: { 'e2e.check/v1': { note: 'nope' } } },
    'on a spatial document',
    'Facets are OKF frontmatter',
  )

  // The seed the rest of this flow needs: two nodes and the edge between
  // them, drawn the way an agent actually draws — one call, explicit
  // geometry (a later step tidies, and a tidy that moves nothing proves
  // nothing).
  const seedBatch = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    ops: [
      {
        op: 'node.add',
        node: {
          id: 'lockable',
          type: 'text',
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          text: 'lockable',
        },
      },
      {
        op: 'node.add',
        node: { id: 'target', type: 'text', x: 10, y: 10, width: 200, height: 100, text: 'target' },
      },
      { op: 'edge.add', edge: { id: 'link', fromNode: 'lockable', toNode: 'target' } },
    ],
  })
  if (seedBatch.applied !== 3 || seedBatch.snapshot.edges[0]?.id !== 'link') {
    throw new Error(`wb_canvas_edit returned unexpected shape: ${JSON.stringify(seedBatch)}`)
  }
  console.log('[e2e] wb_canvas_edit → lockable, target, lockable→target')

  await expectToolError(
    'wb_canvas_edit',
    {
      workspaceId: WORKSPACE_ID,
      documentId,
      ops: [
        {
          op: 'node.add',
          node: {
            id: 'lockable',
            type: 'text',
            x: 1,
            y: 1,
            width: 10,
            height: 10,
            text: 'clobber',
          },
        },
      ],
    },
    'on an id that is already taken',
    'is already on the canvas',
  )

  // An edge whose endpoint does not exist is refused by the batch itself,
  // before the canvas schema ever sees it — so the message names the op
  // rather than a schema path.
  await expectToolError(
    'wb_canvas_edit',
    {
      workspaceId: WORKSPACE_ID,
      documentId,
      ops: [{ op: 'edge.add', edge: { id: 'dangling', fromNode: 'lockable', toNode: 'ghost' } }],
    },
    'with an endpoint the canvas does not have',
    'add that node first',
  )

  await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    ops: [{ op: 'node.lock', id: 'lockable', locked: true }],
  })
  console.log('[e2e] wb_canvas_edit → lockable locked')

  // The lock binds agents, not just the pointer.
  await expectToolError(
    'wb_canvas_edit',
    {
      workspaceId: WORKSPACE_ID,
      documentId,
      ops: [{ op: 'node.patch', id: 'lockable', patch: { x: 999 } }],
    },
    'on a locked node',
    'is locked',
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

  await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    ops: [{ op: 'node.lock', id: 'lockable', locked: false }],
  })

  // wb_scene_render: its structuredContent is built through server-core's
  // layoutSpatialCanvas delegate (compose-canvas-scene.ts) rather than read
  // back from stored content — this is the runtime guard that the laid-out
  // scene still validates against canvasRenderSvgOutputSchema through the
  // real MCP SDK, which a type-level check cannot see.
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

  // The opt-in layout analysis is a SECOND composition through the same
  // output schema, reached only when `layout` is set, so the default read
  // below cannot cover it. It is also the only tool result still built
  // through server-core's layoutSpatialCanvas delegate besides
  // wb_scene_render — which makes this the runtime guard that a laid-out
  // scene still validates through the real MCP SDK.
  const analysed = await callTool('wb_canvas_snapshot', {
    workspaceId: WORKSPACE_ID,
    documentId,
    layout: true,
  })
  if (analysed.layout === undefined || !Array.isArray(analysed.layout.clusters)) {
    throw new Error(
      `wb_canvas_snapshot(layout) returned unexpected shape: ${JSON.stringify(analysed)}`,
    )
  }
  // The names have to be the ones wb_canvas_edit takes. An analysis that
  // reads back positionally still satisfies the schema and still looks right
  // in a unit test, while telling a reader to patch a node that does not exist.
  if (!analysed.nodes.some((node) => node.id === 'lockable')) {
    throw new Error(
      `wb_canvas_snapshot did not name the seeded node by its document id: ${JSON.stringify(analysed.nodes)}`,
    )
  }
  console.log('[e2e] wb_canvas_snapshot(layout:true) → analysis naming the seeded node by id')

  // The DEFAULT read: stored content only, no layout pass. This is the
  // runtime guard that the semantic projection (node text, type, lock state,
  // edges) still validates against canvasSnapshotSchema through the real MCP
  // SDK, and it pins the honesty of the caps — nodeCount is the board's real
  // total, not the returned length.
  const snapshot = await callTool('wb_canvas_snapshot', {
    workspaceId: WORKSPACE_ID,
    documentId,
  })
  const seeded = Array.isArray(snapshot.nodes)
    ? snapshot.nodes.find((node) => node.id === 'lockable')
    : undefined
  if (seeded === undefined || seeded.type !== 'text' || typeof seeded.text !== 'string') {
    throw new Error(`wb_canvas_snapshot returned unexpected shape: ${JSON.stringify(snapshot)}`)
  }
  if (snapshot.nodeCount !== snapshot.nodes.length || snapshot.truncated !== false) {
    throw new Error(
      `wb_canvas_snapshot miscounted an uncapped board: ${JSON.stringify({
        nodeCount: snapshot.nodeCount,
        returned: snapshot.nodes.length,
        truncated: snapshot.truncated,
      })}`,
    )
  }
  console.log('[e2e] wb_canvas_snapshot → semantic nodes/edges with honest totals')

  // wb_canvas_edit is the whole spatial-mutation surface, so the smoke has
  // to reach the parts a unit test cannot: the batch's structuredContent vs
  // its outputSchema through the real MCP SDK, and — because this tool
  // decides ids and coordinates the caller never supplied — that what it
  // REPORTS placing is what it actually stored.
  const applied = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    ops: [
      { op: 'node.add', node: { id: 'batch-a', type: 'text', text: 'batched A' } },
      { op: 'node.add', node: { id: 'batch-b', type: 'text', text: 'batched B' } },
      { op: 'edge.add', edge: { id: 'batch-e', fromNode: 'batch-a', toNode: 'batch-b' } },
    ],
  })
  if (applied.applied !== 3 || !applied.touched.nodes.includes('batch-a')) {
    throw new Error(`wb_canvas_edit returned unexpected shape: ${JSON.stringify(applied)}`)
  }
  const placedA = applied.geometry.find((entry) => entry.id === 'batch-a')
  if (placedA === undefined) {
    throw new Error(
      `wb_canvas_edit placed a node with no coordinates but did not report it: ${JSON.stringify(applied.geometry)}`,
    )
  }
  const inSnapshot = applied.snapshot.nodes.find((node) => node.id === 'batch-a')
  if (inSnapshot?.x !== placedA.x || inSnapshot?.y !== placedA.y) {
    throw new Error(
      `wb_canvas_edit reported a placement its own snapshot disagrees with: ${JSON.stringify({ placedA, inSnapshot })}`,
    )
  }
  console.log('[e2e] wb_canvas_edit → 3 ops in one transaction, placement reported and stored')

  // All-or-nothing across the real wire: the second op cannot apply, so the
  // first must not survive either.
  await expectToolError(
    'wb_canvas_edit',
    {
      workspaceId: WORKSPACE_ID,
      documentId,
      ops: [
        {
          op: 'node.add',
          node: { id: 'batch-rollback', type: 'text', text: 'should not persist' },
        },
        { op: 'node.patch', id: 'no-such-node', patch: { x: 1 } },
      ],
    },
    'with a second op that cannot apply',
    'ops[1]',
  )
  const afterRollback = await callTool('wb_canvas_snapshot', {
    workspaceId: WORKSPACE_ID,
    documentId,
  })
  if (afterRollback.nodes.some((node) => node.id === 'batch-rollback')) {
    throw new Error('wb_canvas_edit persisted the first op of a batch it rejected')
  }
  console.log('[e2e] wb_canvas_edit → rejected batch left nothing behind')

  // region.set is the one op that deletes by OMISSION, so the smoke drives
  // the full reconcile through the real wire: declare two, then declare one,
  // and the other must be gone. The group sits far from everything else so
  // nothing already on this canvas is enclosed by it.
  await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    ops: [
      {
        op: 'node.add',
        node: { id: 'region', type: 'group', x: 5000, y: 5000, width: 900, height: 600 },
      },
      {
        op: 'region.set',
        within: 'region',
        nodes: [
          { id: 'in-1', type: 'text', text: 'first' },
          { id: 'in-2', type: 'text', text: 'second' },
        ],
        edges: [],
      },
    ],
    follow: false,
  })
  const reconciled = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    ops: [
      {
        op: 'region.set',
        within: 'region',
        nodes: [{ id: 'in-1', type: 'text', text: 'first' }],
        edges: [],
      },
    ],
    follow: false,
  })
  const survivors = reconciled.snapshot.nodes.map((node) => node.id)
  if (!survivors.includes('in-1') || survivors.includes('in-2')) {
    throw new Error(
      `region.set did not reconcile the region: ${JSON.stringify({ survivors, touched: reconciled.touched })}`,
    )
  }
  // Everything outside the region is untouched by it — the property that
  // makes deleting-by-omission safe to hand an agent at all.
  if (!survivors.includes('lockable') || !survivors.includes('batch-a')) {
    throw new Error(`region.set reached outside its region: ${JSON.stringify(survivors)}`)
  }
  console.log('[e2e] wb_canvas_edit(region.set) → region reconciled, rest of the board untouched')

  // wb_viewport_set with nobody watching. This smoke runs headless, so
  // delivered:false IS the success path — the point is that asking a
  // browser to look somewhere does not FAIL when there is no browser, which
  // is what would make every headless agent run look broken.
  const viewport = await callTool('wb_viewport_set', {
    workspaceId: WORKSPACE_ID,
    documentId,
    mode: 'fit',
    elementIds: ['lockable'],
  })
  if (viewport.documentId !== documentId || viewport.delivered !== false) {
    throw new Error(`wb_viewport_set returned unexpected shape: ${JSON.stringify(viewport)}`)
  }
  console.log('[e2e] wb_viewport_set → delivered:false with no browser attached (not an error)')

  // The tidy op: what this asserts is the full pipeline (input parse → doc
  // load → tidy → structuredContent vs outputSchema), which is the drift
  // guard this smoke exists for. How far anything moves is geometry, covered
  // by canvas-render's unit/property tests — so this checks the shape of
  // every entry rather than a move count, which would only be restating the
  // layout the nodes above happen to have. `lockable` and `target` were
  // seeded overlapping, so there IS something to separate.
  const tidied = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    ops: [{ op: 'tidy' }],
  })
  if (
    tidied.documentId !== documentId ||
    !Array.isArray(tidied.geometry) ||
    tidied.geometry.some(
      (m) => typeof m.id !== 'string' || typeof m.x !== 'number' || typeof m.y !== 'number',
    )
  ) {
    throw new Error(`wb_canvas_edit(tidy) returned unexpected shape: ${JSON.stringify(tidied)}`)
  }
  console.log(`[e2e] wb_canvas_edit(tidy) → ${tidied.geometry.length} move(s), each well-formed`)

  await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    ops: [{ op: 'edge.lock', id: 'link', locked: true }],
  })
  console.log('[e2e] wb_canvas_edit → link locked')

  await expectToolError(
    'wb_canvas_edit',
    {
      workspaceId: WORKSPACE_ID,
      documentId,
      ops: [{ op: 'edge.patch', id: 'link', patch: { label: 'nope' } }],
    },
    'on a locked edge',
    'is locked',
  )

  await expectToolError(
    'wb_canvas_edit',
    {
      workspaceId: WORKSPACE_ID,
      documentId,
      ops: [{ op: 'edge.lock', id: 'no-such-edge', locked: true }],
    },
    'with an id the canvas does not have',
    'is not on the canvas',
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
    'wb_canvas_edit',
    {
      workspaceId: WORKSPACE_ID,
      documentId: mdCanvasId,
      ops: [{ op: 'node.add', node: { id: 'stray', type: 'text', text: 'stray' } }],
    },
    'on a markdown document',
    'This edits a JSON Canvas',
  )

  const importMarkdown = [
    '---',
    'type: issue',
    'title: "Smoke test issue"',
    'tags:',
    '  - smoke',
    '  - e2e',
    'facets:',
    '  example.sample/v1:',
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
  if (!exported.frontmatter.facets?.['example.sample/v1']) {
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
