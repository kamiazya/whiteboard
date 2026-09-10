#!/usr/bin/env node
// End-to-end smoke test that runs through an MCP stdio subprocess.
//
// Purpose:
// Start the MCP server outside the parent client's context and verify that each
// document tool behaves according to spec using JSON-RPC stdio.
//
// Coverage:
//   1. tools/list matches the authoritative set in mcp-smoke-coverage.ts
//   2. wb_workspace_edit → wb_facet_set → wb_version_save → wb_version_list → wb_version_restore
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
 * `wb_document_get` answers with a LIST since it took `documentIds`. Most
 * steps here read one document, so this unwraps that case and refuses a
 * `failed` entry rather than letting `undefined.content` report as a
 * content mismatch three lines later.
 */
async function readDocument(documentId, options) {
  const out = await callTool('wb_document_get', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    ...(options ? { options } : {}),
  })
  if (out.failed.length > 0) {
    throw new Error(`wb_document_get refused ${documentId}: ${out.failed[0].reason}`)
  }
  if (out.documents.length !== 1) {
    throw new Error(`wb_document_get answered ${out.documents.length} documents for one id`)
  }
  return out.documents[0]
}

/**
 * `wb_workspace_edit` is the ONE front door onto document create / set /
 * delete — the standalone `wb_document_create`, `wb_document_set` and
 * `wb_document_delete` tools are retired. These three unwrap its batch reply
 * for the single-document steps below, so each step still reads as the thing
 * it is testing rather than as a batch envelope.
 *
 * They deliberately do NOT hide the tool being called: the steps that are
 * ABOUT the batch (an ordered multi-op run, a failing op mid-batch) still
 * call it directly.
 */
async function createDocument({ workspaceId = WORKSPACE_ID, ...op }, batch = {}) {
  const out = await callTool('wb_workspace_edit', {
    workspaceId,
    ...batch,
    ops: [{ op: 'document.create', ...op }],
  })
  const first = out.results[0]
  if (first === undefined) {
    throw new Error(`wb_workspace_edit applied no op for a create: ${JSON.stringify(out)}`)
  }
  return { workspaceId: out.workspaceId, documentId: first.documentId, path: first.path }
}

async function setDocument({ workspaceId = WORKSPACE_ID, documentId, markdown }, batch = {}) {
  return callTool('wb_workspace_edit', {
    workspaceId,
    ...batch,
    ops: [{ op: 'document.set', documentId, markdown }],
  })
}

async function deleteDocument({ workspaceId = WORKSPACE_ID, documentId }) {
  return callTool('wb_workspace_edit', {
    workspaceId,
    ops: [{ op: 'document.delete', documentId }],
  })
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
  'wb_body_edit',
  'wb_canvas_snapshot',
  'wb_canvas_edit',
  'wb_thread_edit',
  'wb_document_get',
  'wb_document_search',
  'wb_scene_render',
  'canvas_view',
  'wb_facet_set',
  'wb_facet_list',
  'wb_version_list',
  'wb_version_restore',
  'wb_version_save',
  'wb_workspace_edit',
  'wb_document_list',
  'wb_pairing_link_create',
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

  // wb_pairing_link_create is registered on this stdio entrypoint too (one
  // authoritative tools/list across transports), but stdio has no HTTP
  // daemon of its own to embed in a pairing link — the success path is
  // covered elsewhere (pairing-link.test.ts's in-process MCP client, and the
  // HTTP-daemon verification recorded outside this offline smoke).
  await expectToolError(
    'wb_pairing_link_create',
    {},
    'over stdio with no HTTP daemon to pair with',
    'standalone over stdio',
  )

  // Unknown-workspace guard: without createWorkspace the create must fail
  // (workspaces never materialize implicitly from a typo'd workspaceId).
  await expectToolError(
    'wb_workspace_edit',
    {
      workspaceId: WORKSPACE_ID,
      ops: [{ op: 'document.create', path: 'e2e-src', kind: 'spatial' }],
    },
    'without createWorkspace',
    'Workspace not found',
  )

  // The first daemon-dependent RPC (cold-start latency).
  const created = await createDocument(
    { path: 'e2e-src', kind: 'spatial' },
    { createWorkspace: true },
  )
  if (typeof created.documentId !== 'string' || created.path !== 'e2e-src') {
    throw new Error(`wb_workspace_edit returned unexpected shape: ${JSON.stringify(created)}`)
  }
  // ADR-0019's mint boundary, end to end through the PUBLISHED artifact.
  // The create decides the workspace's canonical id — so what it REPORTS is
  // a ULID, not the `e2e` handle that was sent. Asserted here as well as in
  // a unit test because the MCP SDK validates structuredContent against
  // outputSchema at runtime, and this is the last place a schema and the
  // value it describes can be caught travelling separately.
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(created.workspaceId ?? '')) {
    throw new Error(
      `wb_workspace_edit did not mint a canonical workspace id: ${JSON.stringify(created)}`,
    )
  }
  if (created.workspaceId === WORKSPACE_ID) {
    throw new Error(`wb_workspace_edit echoed the handle instead of minting: ${WORKSPACE_ID}`)
  }
  const documentId = created.documentId
  console.log(
    `[e2e] document.create → ${documentId} in ${created.workspaceId} (segment ${WORKSPACE_ID})`,
  )

  // ...and every call after this one still addresses the workspace as
  // `WORKSPACE_ID`. That the rest of this smoke passes unchanged IS the
  // proof that segment-first resolution works through the published
  // artifact: the id underneath changed, and the address did not.

  // A document's name is the workspace's, not its content's (ADR-0009), so
  // it round-trips through create -> list without any document read.
  const named = await createDocument({
    path: 'e2e-named',
    kind: 'markdown',
    name: 'リリース計画 2026 / v2',
  })
  // A markdown document arrives with its body in ONE call. The MCP SDK
  // validates structuredContent against outputSchema at runtime, so this is
  // also where a discriminated-union input schema proves it survives the
  // wire: the shape a client sends is not the shape a test constructs.
  const withBody = await createDocument({
    path: 'e2e-with-body',
    kind: 'markdown',
    name: 'created with its body',
    markdown: '---\ntype: note\ntags:\n  - e2e\n---\nWritten at creation time.',
  })
  const readBack = await readDocument(withBody.documentId)
  if (!readBack.content.includes('Written at creation time.')) {
    throw new Error(`document.create did not persist its body: ${readBack.content}`)
  }
  console.log('[e2e] document.create → body written in one call')

  // Axis B on a read: the two documents come back in ONE call, each in its
  // own format, and an id nothing was created under lands in `failed`
  // rather than taking the other two with it. Provable only through a
  // client — the schema alone cannot say what the server does with a mix.
  const bulk = await callTool('wb_document_get', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId, withBody.documentId, '01ZZZZZZZZZZZZZZZZZZZZZZZZ'],
  })
  if (
    bulk.documents.map((entry) => entry.documentId).join() !==
    [documentId, withBody.documentId].join()
  ) {
    throw new Error(
      `wb_document_get did not answer in the order asked: ${JSON.stringify(bulk.documents.map((entry) => entry.documentId))}`,
    )
  }
  if (bulk.documents.map((entry) => entry.kind).join() !== 'spatial,markdown') {
    throw new Error(
      `wb_document_get did not read each document in its own format: ${JSON.stringify(bulk.documents.map((entry) => entry.kind))}`,
    )
  }
  if (bulk.failed.length !== 1 || bulk.failed[0].documentId !== '01ZZZZZZZZZZZZZZZZZZZZZZZZ') {
    throw new Error(
      `wb_document_get did not report the unreadable id: ${JSON.stringify(bulk.failed)}`,
    )
  }
  console.log('[e2e] wb_document_get → two kinds in one call, the unreadable id reported not fatal')

  // wb_body_edit against a REAL markdown document, which is the thing
  // wb_body_patch cannot reach at all: its canvas read never sees the body's
  // text container, so it answers NodeNotFoundError for `okf-body`. This step
  // exists to keep that gap closed — it is only provable through a client
  // that owns a real store, since a unit test seeds whatever shape it likes.
  const edited = await callTool('wb_body_edit', {
    workspaceId: WORKSPACE_ID,
    documentId: withBody.documentId,
    // Explicit, because the DEFAULT proposes — the step below pins that.
    mode: 'apply',
    ops: [
      {
        id: 'e2e-passage-1',
        op: 'body.replace',
        anchor: {
          kind: 'text',
          quote: { exact: 'creation time' },
          // Deliberately stale: the frontmatter above shifts every offset the
          // caller could have taken from the body it wrote. The quote is what
          // finds the passage, and a line number could not have.
          start: 0,
          end: 13,
        },
        text: 'the smoke',
        assumed: 'creation time',
      },
    ],
  })
  if (edited.applied !== 1 || !edited.body.includes('Written at the smoke.')) {
    throw new Error(`wb_body_edit returned unexpected shape: ${JSON.stringify(edited)}`)
  }
  const afterEdit = await readDocument(withBody.documentId)
  if (!afterEdit.content.includes('Written at the smoke.')) {
    throw new Error(`wb_body_edit did not persist through the store: ${afterEdit.content}`)
  }
  if (afterEdit.content.includes('creation time')) {
    throw new Error(`wb_body_edit left the old passage behind: ${afterEdit.content}`)
  }

  // The refusal a person's adopt depends on: a passage that no longer says
  // what the caller assumed is named, not overwritten.
  await expectToolError(
    'wb_body_edit',
    {
      workspaceId: WORKSPACE_ID,
      documentId: withBody.documentId,
      mode: 'apply',
      ops: [
        {
          id: 'e2e-passage-stale',
          op: 'body.replace',
          anchor: { kind: 'text', quote: { exact: 'the smoke' }, start: 0, end: 9 },
          text: 'never written',
          assumed: 'creation time',
        },
      ],
    },
    'on a passage that no longer says what was assumed',
    'e2e-passage-stale',
  )
  console.log('[e2e] wb_body_edit → passage replaced by quote, stale assumption refused by name')

  // The flipped default (ADR-0029 decision 7, applied to prose): a call that
  // names no mode PROPOSES, and the body does not move. Asserted in both
  // directions in one place, because a default is exactly the kind of
  // behaviour a unit test can pin while the registered schema disagrees.
  const proposedPassage = await callTool('wb_body_edit', {
    workspaceId: WORKSPACE_ID,
    documentId: withBody.documentId,
    ops: [
      {
        id: 'e2e-passage-proposed',
        op: 'body.replace',
        anchor: { kind: 'text', quote: { exact: 'the smoke' }, start: 0, end: 9 },
        text: 'a proposal nobody adopted',
        assumed: 'the smoke',
      },
    ],
  })
  if (proposedPassage.applied !== 0 || proposedPassage.proposed?.changes?.length !== 1) {
    throw new Error(`the default did not propose a passage: ${JSON.stringify(proposedPassage)}`)
  }
  const proposedChange = proposedPassage.proposed.changes[0]
  if (proposedChange.op !== 'body.replace' || proposedChange.status !== 'open') {
    throw new Error(`proposed change has an unexpected shape: ${JSON.stringify(proposedChange)}`)
  }
  const bodyAfterPropose = await readDocument(withBody.documentId)
  if (bodyAfterPropose.content.includes('a proposal nobody adopted')) {
    throw new Error(`a proposed passage reached the body: ${bodyAfterPropose.content}`)
  }
  if (!bodyAfterPropose.content.includes('Written at the smoke.')) {
    throw new Error(`proposing changed the body: ${bodyAfterPropose.content}`)
  }
  console.log('[e2e] wb_body_edit(no mode) → passage proposed, body untouched')

  // The union's other side: a spatial document takes no markdown, and the
  // refusal must reach the client rather than the content being dropped.
  await expectToolError(
    'wb_workspace_edit',
    {
      workspaceId: WORKSPACE_ID,
      ops: [
        { op: 'document.create', path: 'e2e-spatial-body', kind: 'spatial', markdown: '# nope' },
      ],
    },
    'with markdown on a spatial document',
    'markdown',
  )

  // wb_workspace_edit: several documents in one call, and the ids come back
  // so no round trip is needed to learn them.
  const batch = await callTool('wb_workspace_edit', {
    workspaceId: WORKSPACE_ID,
    // One actor for the whole batch. The SDK validates it against
    // `okfActorSchema` at the boundary, so this also proves the batch did
    // not widen the field to a plain string.
    actor: 'reference_agent/e2e-smoke',
    ops: [
      {
        op: 'document.create',
        path: 'e2e-batch-a',
        kind: 'markdown',
        markdown: '---\ntype: note\n---\nalpha',
      },
      { op: 'document.create', path: 'e2e-batch-b', kind: 'spatial', name: 'batch canvas' },
    ],
  })
  if (batch.applied !== 2 || batch.results.length !== 2) {
    throw new Error(`wb_workspace_edit returned unexpected shape: ${JSON.stringify(batch)}`)
  }
  if (batch.results.some((r) => typeof r.documentId !== 'string')) {
    throw new Error(`wb_workspace_edit did not report the ids it minted: ${JSON.stringify(batch)}`)
  }
  const batchExport = await callTool('wb_document_get', {
    workspaceId: WORKSPACE_ID,
    documentIds: [batch.results[0].documentId],
  })
  if (!batchExport.documents[0].content.includes('reference_agent/e2e-smoke')) {
    throw new Error(
      `wb_workspace_edit did not stamp the batch actor: ${batchExport.documents[0].content}`,
    )
  }
  console.log('[e2e] wb_workspace_edit → two documents, ids returned, batch actor stamped')

  // A failing op stops the run, and the message must say how far it got:
  // documents are separate CRDTs, so "nothing was written" would be false
  // and a caller acting on it would create the earlier ones twice.
  await expectToolError(
    'wb_workspace_edit',
    {
      workspaceId: WORKSPACE_ID,
      ops: [
        { op: 'document.create', path: 'e2e-batch-c', kind: 'markdown' },
        { op: 'document.create', path: 'e2e-batch-a', kind: 'markdown' },
      ],
    },
    'with an op that collides with an existing path',
    'were applied and stand',
  )
  const afterPartial = await callTool('wb_document_list', { workspaceId: WORKSPACE_ID })
  if (!afterPartial.documents.some((d) => d.path === 'e2e-batch-c')) {
    throw new Error('wb_workspace_edit rolled back an op it reported as applied')
  }
  console.log('[e2e] wb_workspace_edit → partial application is reported, not hidden')

  const namedList = await callTool('wb_document_list', { workspaceId: WORKSPACE_ID })
  const namedRow = namedList.documents.find((c) => c.documentId === named.documentId)
  if (namedRow?.name !== 'リリース計画 2026 / v2') {
    throw new Error(`wb_document_list lost the document name: ${JSON.stringify(namedRow)}`)
  }
  const unnamedRow = namedList.documents.find((c) => c.documentId === documentId)
  if (unnamedRow === undefined || 'name' in unnamedRow) {
    throw new Error(`an unnamed document should carry no name: ${JSON.stringify(unnamedRow)}`)
  }
  console.log('[e2e] document.create/list → name round-trips, unnamed stays unnamed')

  // id → placement is a row of wb_document_list now; the standalone
  // wb_document_resolve is retired (ADR-0031 §4).
  const resolvedRow = namedList.documents.find((d) => d.documentId === named.documentId)
  if (resolvedRow === undefined || resolvedRow.path !== named.path) {
    throw new Error(
      `wb_document_list does not place ${named.documentId}: ${JSON.stringify(namedList)}`,
    )
  }
  console.log(`[e2e] wb_document_list places ${resolvedRow.documentId} at ${resolvedRow.path}`)

  // document.delete: a throwaway document, deleted and gone from the list.
  const doomed = await createDocument({ path: 'doomed', kind: 'spatial' })
  const deletion = await deleteDocument({ documentId: doomed.documentId })
  if (deletion.applied !== 1) {
    throw new Error(`document.delete returned unexpected shape: ${JSON.stringify(deletion)}`)
  }
  const afterDelete = await callTool('wb_document_list', { workspaceId: WORKSPACE_ID })
  if (afterDelete.documents.some((doc) => doc.documentId === doomed.documentId)) {
    throw new Error('document.delete left the document in the listing')
  }
  console.log('[e2e] document.delete → deleted and gone from the list')

  // A facet is OKF frontmatter, so it belongs to the markdown document; the
  // spatial one refuses it.
  const facets = await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [named.documentId],
    facets: { 'e2e.check/v1': { note: 'before-save' } },
  })
  if (facets.updated[0]?.documentId !== named.documentId) {
    throw new Error(`wb_facet_set returned unexpected shape: ${JSON.stringify(facets)}`)
  }
  console.log('[e2e] wb_facet_set → set on the markdown document')

  await expectToolError(
    'wb_facet_set',
    {
      workspaceId: WORKSPACE_ID,
      documentIds: [documentId],
      facets: { 'e2e.check/v1': { note: 'nope' } },
    },
    'on a spatial document',
    'Facets are OKF frontmatter',
  )

  // A REGISTERED facet is checked on write (ADR-0013 decision 6). What this
  // step provably exercises is the TARGET check: visual.edges is
  // canvas-target, and this document-writing tool rejects it before the
  // payload schema is consulted. The schema-invalid branch for a
  // document-target registered facet is covered at the unit layer
  // (facet-set.test.ts) — the bundled registry has no document-target facet
  // for this smoke to send.
  await expectToolError(
    'wb_facet_set',
    {
      workspaceId: WORKSPACE_ID,
      documentIds: [named.documentId],
      facets: { 'visual.edges/v0': { routing: 'spiral' } },
    },
    'with a canvas-target registered facet',
    'visual.edges/v0',
  )
  console.log('[e2e] wb_facet_set → registered-facet validation rejects an invalid payload')

  // The seed the rest of this flow needs: two nodes and the edge between
  // them, drawn the way an agent actually draws — one call, explicit
  // geometry (a later step tidies, and a tidy that moves nothing proves
  // nothing).
  const seedBatch = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    mode: 'apply',
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

  // The EDGE slot (ADR-0013 decision 5), through a real client so the SDK
  // validates the result against `facetSetOutputSchema` at runtime. Written
  // here rather than at the unit layer alone because the edge is the third
  // `x-whiteboard` site, and the bucket has to survive the Loro field
  // mapping in both directions — an earlier site did not, silently, because
  // nothing read it back.
  const edgeFacet = await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    edgeId: 'link',
    facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
  })
  if (edgeFacet.updated[0]?.facets?.['visual.edges/v0']?.routing !== 'orthogonal') {
    throw new Error(
      `edge-target wb_facet_set returned unexpected shape: ${JSON.stringify(edgeFacet)}`,
    )
  }
  const afterEdgeFacet = await callTool('wb_canvas_snapshot', {
    workspaceId: WORKSPACE_ID,
    documentId,
  })
  const storedEdge = (afterEdgeFacet.edges ?? []).find((entry) => entry.id === 'link')
  if (storedEdge === undefined) {
    throw new Error(
      `the edge vanished after an edge-target facet write: ${JSON.stringify(afterEdgeFacet.edges)}`,
    )
  }
  console.log('[e2e] wb_facet_set → edge-target facet stored on the edge')

  // A node-target facet on an edge is refused by the same target check the
  // canvas and node branches use, from the third side.
  await expectToolError(
    'wb_facet_set',
    {
      workspaceId: WORKSPACE_ID,
      documentIds: [documentId],
      edgeId: 'link',
      facets: { 'visual.shape/v0': { kind: 'hexagon' } },
    },
    'with a node-target facet on an edge',
    'targets an edge',
  )
  console.log('[e2e] wb_facet_set → a node-target facet is refused on an edge')

  // A CONTRIBUTED router, end to end: `visual.path/v0` is the plugin's own
  // facet, and the renderer draws it only through the router contribution
  // point. Nothing in the type system connects the facet a tool writes to
  // the polyline the daemon emits, so this is the step that would catch the
  // contribution being dropped from the bundled plugin, or the bends being
  // lost between the Loro edge bucket and the layout.
  const BEND = { x: 4242, y: -1337 }
  await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    edgeId: 'link',
    facets: { 'visual.path/v0': { waypoints: [BEND] } },
  })
  const bent = await callTool('wb_scene_render', { workspaceId: WORKSPACE_ID, documentId })
  if (typeof bent.svg !== 'string' || !bent.svg.includes(`${BEND.x},${BEND.y}`)) {
    throw new Error('wb_scene_render drew no edge through the stored bend')
  }
  console.log('[e2e] wb_facet_set + wb_scene_render → the contributed router draws a stored bend')

  // Cleared again, so every later step reads the canvas the rest of this
  // smoke was written against.
  await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    edgeId: 'link',
    facets: { 'visual.path/v0': null },
  })

  // Propose mode (ADR-0029). Through a real MCP client, so the SDK validates
  // the `proposed` payload against `proposalSchema` at runtime — the drift
  // the type system cannot see, and the reason this step is here rather than
  // only in a unit test.
  const proposed = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    mode: 'propose',
    ops: [{ op: 'node.patch', id: 'target', patch: { x: 900 } }],
  })
  const change = proposed.proposed?.changes?.[0]
  if (proposed.applied !== 0 || change?.op !== 'node.patch' || change?.assumed?.x !== 10) {
    throw new Error(`propose returned unexpected shape: ${JSON.stringify(proposed)}`)
  }
  // The board itself must be untouched: a proposal that quietly applied
  // would pass every assertion above.
  const afterPropose = await callTool('wb_canvas_snapshot', {
    workspaceId: WORKSPACE_ID,
    documentId,
  })
  if (afterPropose.nodes.find((node) => node.id === 'target')?.x !== 10) {
    throw new Error(`propose moved the board: ${JSON.stringify(afterPropose.nodes)}`)
  }
  await expectToolError(
    'wb_canvas_edit',
    { workspaceId: WORKSPACE_ID, documentId, mode: 'propose', ops: [{ op: 'tidy' }] },
    'proposing a verb with no anchor',
    'a proposal cannot carry this verb',
  )
  console.log('[e2e] wb_canvas_edit(mode:propose) → stored, board untouched, tidy refused')

  // ADR-0029 decision 7's flip, through a real MCP client: with NO mode, a
  // batch of content is proposed and the board does not move, while a batch
  // carrying something a proposal cannot represent applies. The compiler
  // cannot see either — `mode` is optional on both sides of the wire — so
  // this is the guard that would catch the default going back.
  const defaulted = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    ops: [{ op: 'node.patch', id: 'target', patch: { x: 4242 } }],
  })
  if (defaulted.applied !== 0 || defaulted.proposed === undefined) {
    throw new Error(`the default did not propose a content batch: ${JSON.stringify(defaulted)}`)
  }
  const afterDefault = await callTool('wb_canvas_snapshot', {
    workspaceId: WORKSPACE_ID,
    documentId,
  })
  if (afterDefault.nodes.find((node) => node.id === 'target')?.x === 4242) {
    throw new Error('the default moved the board instead of proposing')
  }
  const defaultedComment = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    ops: [{ op: 'comment.add', comment: { targetNodeId: 'target', text: 'applied by default' } }],
  })
  if (defaultedComment.applied !== 1 || defaultedComment.proposed !== undefined) {
    throw new Error(
      `a batch carrying nothing proposable did not apply: ${JSON.stringify(defaultedComment)}`,
    )
  }
  console.log('[e2e] wb_canvas_edit(no mode) → content proposed, a comment applied')

  // Facet discovery: an agent learns the exact keys and payload contracts
  // rather than guessing them, which is what the writes below rely on.
  const registered = await callTool('wb_facet_list', {})
  const registeredKeys = (registered.facets ?? []).map((facet) => facet.key)
  for (const expected of ['visual.edges/v0', 'visual.shape/v0', 'visual.symbol/v0']) {
    if (!registeredKeys.includes(expected)) {
      throw new Error(`wb_facet_list omitted ${expected}: ${JSON.stringify(registeredKeys)}`)
    }
  }
  const shapeEntry = (registered.facets ?? []).find((facet) => facet.key === 'visual.shape/v0')
  if (!shapeEntry?.targets?.includes('node') || shapeEntry?.schema?.type !== 'object') {
    throw new Error(`wb_facet_list entry is not actionable: ${JSON.stringify(shapeEntry)}`)
  }
  console.log(`[e2e] wb_facet_list → ${registeredKeys.length} registered facets, with schemas`)
  const nodeOnly = await callTool('wb_facet_list', { target: 'node' })
  const nodeKeys = (nodeOnly.facets ?? []).map((facet) => facet.key)
  // Both directions: nothing foreign leaked in, and the filter did not
  // simply answer with nothing — an empty list would satisfy the first
  // check alone.
  if ((nodeOnly.facets ?? []).some((facet) => !facet.targets.includes('node'))) {
    throw new Error(`wb_facet_list(target) leaked a non-node facet: ${JSON.stringify(nodeOnly)}`)
  }
  if (!nodeKeys.includes('visual.shape/v0') || nodeKeys.includes('visual.edges/v0')) {
    throw new Error(`wb_facet_list(target: node) filtered wrongly: ${JSON.stringify(nodeKeys)}`)
  }
  console.log('[e2e] wb_facet_list(target: node) → filtered to node-target facets')

  // Node-target facets (ADR-0013): set a silhouette on one node of the
  // spatial document, then delete it with the null tombstone.
  const nodeFacet = await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    nodeId: 'target',
    facets: { 'visual.shape/v0': { kind: 'hexagon' } },
  })
  if (nodeFacet.updated[0]?.facets?.['visual.shape/v0']?.kind !== 'hexagon') {
    throw new Error(`wb_facet_set(nodeId) returned unexpected shape: ${JSON.stringify(nodeFacet)}`)
  }
  console.log('[e2e] wb_facet_set(nodeId) → visual.shape set on a node')
  const nodeFacetCleared = await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    nodeId: 'target',
    facets: { 'visual.shape/v0': null },
  })
  if (Object.keys(nodeFacetCleared.updated[0]?.facets ?? { leftover: true }).length !== 0) {
    throw new Error(`null tombstone did not delete: ${JSON.stringify(nodeFacetCleared)}`)
  }
  console.log('[e2e] wb_facet_set(nodeId) → null tombstone deletes the facet')
  // Two node facets coexist on one node: the write merges rather than
  // replacing the bucket, which is what a second plugin's facet depends on.
  await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    nodeId: 'target',
    facets: { 'visual.shape/v0': { kind: 'ellipse' } },
  })
  const bothFacets = await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    nodeId: 'target',
    facets: { 'visual.symbol/v0': { kind: 'icon', name: 'star' } },
  })
  if (
    bothFacets.updated[0]?.facets?.['visual.symbol/v0']?.name !== 'star' ||
    bothFacets.updated[0]?.facets?.['visual.shape/v0']?.kind !== 'ellipse'
  ) {
    throw new Error(`node facets did not merge: ${JSON.stringify(bothFacets)}`)
  }
  console.log('[e2e] wb_facet_set(nodeId) → visual.symbol merges beside visual.shape')
  const bothCleared = await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    nodeId: 'target',
    facets: { 'visual.shape/v0': null, 'visual.symbol/v0': null },
  })
  if (Object.keys(bothCleared.updated[0]?.facets ?? { leftover: true }).length !== 0) {
    throw new Error(`combined null tombstones did not delete: ${JSON.stringify(bothCleared)}`)
  }
  console.log('[e2e] wb_facet_set(nodeId) → one call deletes both node facets')
  await expectToolError(
    'wb_facet_set',
    {
      workspaceId: WORKSPACE_ID,
      documentIds: [documentId, named.documentId],
      nodeId: 'target',
      facets: { 'visual.shape/v0': { kind: 'ellipse' } },
    },
    'with a nodeId and several documentIds',
    'nodeId names a node of ONE document',
  )
  console.log('[e2e] wb_facet_set → a nodeId across several documents is refused')
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
    mode: 'apply',
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
  const exportedWithLocks = await readDocument(documentId)
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
    mode: 'apply',
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

  // A canvas-target facet (ADR-0030): the document names a theme through
  // wb_facet_set's canvas target, the default render stays clean, and a
  // styled render draws it — the whole agent path, end to end.
  const themed = await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    target: 'canvas',
    facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
  })
  if (themed.updated[0]?.facets?.['visual.theme/v0']?.theme !== 'visual.neon') {
    throw new Error(
      `wb_facet_set(target: canvas) returned unexpected shape: ${JSON.stringify(themed)}`,
    )
  }
  console.log("[e2e] wb_facet_set(target: 'canvas') → visual.theme set on the canvas")
  const cleanByDefault = await callTool('wb_scene_render', {
    workspaceId: WORKSPACE_ID,
    documentId,
  })
  // The glow's filter id, not the bare word: a drop shadow is a filter too.
  if (cleanByDefault.svg.includes('wb-glow')) {
    throw new Error('wb_scene_render drew the document theme without being asked')
  }
  const styled = await callTool('wb_scene_render', {
    workspaceId: WORKSPACE_ID,
    documentId,
    style: 'document',
  })
  if (!styled.svg.includes('filterUnits="userSpaceOnUse"')) {
    throw new Error(`wb_scene_render(style: document) drew no glow: ${styled.svg.slice(0, 300)}`)
  }
  console.log("[e2e] wb_scene_render(style: 'document') → the neon glow; the default stayed clean")
  const unthemed = await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    target: 'canvas',
    facets: { 'visual.theme/v0': null },
  })
  if (Object.keys(unthemed.updated[0]?.facets ?? { leftover: true }).length !== 0) {
    throw new Error(`canvas facet tombstone did not delete: ${JSON.stringify(unthemed)}`)
  }
  console.log("[e2e] wb_facet_set(target: 'canvas') → null tombstone clears the theme")

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

  // A MARKDOWN document renders too, as a page, and `embedReferences` there
  // draws the canvas a `![[path]]` embed names as a miniature — the third
  // composition through the same output schema (layoutMdastBlocks with the
  // spatial composer behind it), reachable from no spatial call above.
  await setDocument({
    documentId: withBody.documentId,
    markdown: '---\ntype: note\n---\nSee the board:\n\n![[e2e-src]]\n\nand more.',
  })
  const renderedMarkdown = await callTool('wb_scene_render', {
    workspaceId: WORKSPACE_ID,
    documentId: withBody.documentId,
    embedReferences: true,
  })
  if (
    typeof renderedMarkdown.svg !== 'string' ||
    !renderedMarkdown.svg.includes('See the board') ||
    !renderedMarkdown.svg.includes('<rect')
  ) {
    throw new Error(
      `wb_scene_render(markdown, embedReferences) returned unexpected shape: ${JSON.stringify(renderedMarkdown).slice(0, 400)}`,
    )
  }
  console.log(
    '[e2e] wb_scene_render(markdown, embedReferences:true) → page with the embedded canvas',
  )

  // The same page under `style: 'document'`. A markdown host names no theme,
  // so what must be drawn is the EMBEDDED board's own (ADR-0030 decision 5) —
  // the style argument reaching a nested layout is exactly what a type check
  // cannot see, and the page renders happily without it.
  await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    target: 'canvas',
    facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
  })
  const styledMarkdown = await callTool('wb_scene_render', {
    workspaceId: WORKSPACE_ID,
    documentId: withBody.documentId,
    embedReferences: true,
    style: 'document',
  })
  if (!styledMarkdown.svg.includes('filterUnits="userSpaceOnUse"')) {
    throw new Error(
      `wb_scene_render(markdown, style: document) drew the embedded board clean: ${styledMarkdown.svg.slice(0, 300)}`,
    )
  }
  await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    target: 'canvas',
    facets: { 'visual.theme/v0': null },
  })
  console.log("[e2e] wb_scene_render(markdown, style: 'document') → the embedded board's own theme")

  // `fragment` names a part the document must hold; an unknown one is a
  // tool error naming it, not a silent whole-document render.
  await expectToolError(
    'wb_scene_render',
    { workspaceId: WORKSPACE_ID, documentId: withBody.documentId, fragment: 'Nowhere' },
    'with a fragment the document does not hold',
    'Nowhere',
  )

  // canvas_view is the MCP Apps UI tool: its payload is consumed by the
  // widget rather than by a model, and it is the only tool whose result
  // carries a `references` map. The SDK validates that map against
  // canvasViewOutputSchema (mdastRootSchema inside), so this call is the
  // runtime guard on a schema a type check cannot see through.
  const viewed = await callTool('canvas_view', { workspaceId: WORKSPACE_ID, documentId })
  if (viewed.documentId !== documentId) {
    throw new Error(`canvas_view echoed the wrong documentId: ${JSON.stringify(viewed)}`)
  }
  // BOTH ids echo: the widget commits the pair from this result and passes
  // it back verbatim on Refresh and on the sticky-note append — an echo of
  // documentId alone leaves the widget unable to construct a valid call.
  if (typeof viewed.workspaceId !== 'string' || viewed.workspaceId.length === 0) {
    throw new Error(`canvas_view did not echo the workspaceId: ${JSON.stringify(viewed)}`)
  }
  if (!Array.isArray(viewed.scene?.nodes) || typeof viewed.references !== 'object') {
    throw new Error(`canvas_view returned unexpected shape: ${JSON.stringify(viewed)}`)
  }
  console.log('[e2e] canvas_view → scene + references + both ids for the widget')
  // The look is the widget's to draw, so the tool only echoes it — and the
  // SDK validates that echo against the outputSchema.
  const viewedStyled = await callTool('canvas_view', {
    workspaceId: WORKSPACE_ID,
    documentId,
    style: 'document',
  })
  if (viewedStyled.style !== 'document') {
    throw new Error(`canvas_view did not echo style: ${JSON.stringify(viewedStyled.style)}`)
  }
  console.log("[e2e] canvas_view(style: 'document') → style echoed for the widget")

  // The widget draws in a bundled family unless it can measure the one the
  // theme names, and it has no catalogue of its own — so the tool answers
  // where that family lives. Only the ANSWER travels: a URL, never the 4 MB
  // behind it. The SDK validates it against canvasViewOutputSchema, which is
  // the point of doing it here.
  await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    target: 'canvas',
    facets: { 'visual.theme/v0': { theme: 'visual.sketch' } },
  })
  const sketched = await callTool('canvas_view', {
    workspaceId: WORKSPACE_ID,
    documentId,
    style: 'document',
  })
  if (sketched.themeFont?.family !== 'Yomogi') {
    throw new Error(`canvas_view named no theme font: ${JSON.stringify(sketched.themeFont)}`)
  }
  if (!sketched.themeFont.url.startsWith('https://raw.githubusercontent.com/')) {
    throw new Error(
      `canvas_view's theme font URL left the catalogue origin: ${sketched.themeFont.url}`,
    )
  }
  // The bundled look draws in the bundled family, so there is nothing to
  // fetch and nothing to say — and the widget's fetch is gated on this.
  const sketchedClean = await callTool('canvas_view', { workspaceId: WORKSPACE_ID, documentId })
  if (sketchedClean.themeFont !== undefined) {
    throw new Error(
      `canvas_view named a theme font under the bundled look: ${JSON.stringify(sketchedClean.themeFont)}`,
    )
  }
  await callTool('wb_facet_set', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    target: 'canvas',
    facets: { 'visual.theme/v0': null },
  })
  console.log("[e2e] canvas_view(style: 'document') → themeFont for the widget; none under clean")

  // The widget's sticky-note append, in ITS EXACT argument shape (a text
  // node with no geometry, auto-placed server-side) — the runtime guard
  // against cross-package literal drift between widget-entry.ts and
  // wb_canvas_edit's schema, which no type check crosses.
  const sticky = await callTool('wb_canvas_edit', {
    workspaceId: viewed.workspaceId,
    documentId: viewed.documentId,
    // The widget is a surface a person is looking at, so it applies. The
    // default would propose this one — it is content — which is the flip
    // ADR-0029 decision 7 made and the step below proves.
    mode: 'apply',
    ops: [{ op: 'node.add', node: { type: 'text', text: 'sticky note from the widget shape' } }],
  })
  if (sticky.applied !== 1) {
    throw new Error(`widget-shaped sticky append did not apply: ${JSON.stringify(sticky)}`)
  }
  const afterSticky = await callTool('canvas_view', { workspaceId: WORKSPACE_ID, documentId })
  const stickyLanded = afterSticky.scene.nodes.some(
    (node) => node.type === 'text' && node.text === 'sticky note from the widget shape',
  )
  if (!stickyLanded) {
    throw new Error('widget-shaped sticky append is not in the refreshed canvas_view scene')
  }
  console.log('[e2e] wb_canvas_edit → widget-shaped sticky note lands and refreshes')

  // The comment annotation layer (ADR-0024): a node-targeted comment.add,
  // its echo through canvas_view (the widget's read), and its resolve —
  // exercised through the real MCP SDK because the ops union, the stored
  // per-comment map, and the outputSchema's `touched.comments` all travel
  // separately from any type the compiler checks.
  const commented = await callTool('wb_canvas_edit', {
    workspaceId: viewed.workspaceId,
    documentId: viewed.documentId,
    ops: [{ op: 'comment.add', comment: { targetNodeId: 'lockable', text: 'smoke comment' } }],
  })
  const commentId = commented.touched?.comments?.[0]
  if (commented.applied !== 1 || commentId === undefined) {
    throw new Error(`comment.add did not report its comment: ${JSON.stringify(commented)}`)
  }
  const afterComment = await callTool('canvas_view', { workspaceId: WORKSPACE_ID, documentId })
  const commentInScene = (afterComment.scene['x-whiteboard']?.comments ?? []).some(
    (comment) => comment.id === commentId && comment.text === 'smoke comment',
  )
  if (!commentInScene) {
    throw new Error('comment.add is not in the refreshed canvas_view scene')
  }
  const resolvedBatch = await callTool('wb_canvas_edit', {
    workspaceId: viewed.workspaceId,
    documentId: viewed.documentId,
    ops: [{ op: 'comment.resolve', id: commentId }],
  })
  const resolvedComment = (resolvedBatch.snapshot.comments ?? []).find(
    (comment) => comment.id === commentId,
  )
  if (resolvedComment?.resolved !== true) {
    throw new Error(`comment.resolve did not mark the record: ${JSON.stringify(resolvedBatch)}`)
  }
  console.log('[e2e] wb_canvas_edit → comment.add reaches canvas_view, comment.resolve marks it')

  // The DOCUMENT-scoped surface (ADR-0026 decision 6): the same layer through
  // `wb_thread_edit`, which is the only way an agent can comment on a format
  // with no canvas. Run against a MARKDOWN document deliberately — reaching it
  // on the spatial canvas would prove nothing the ops above do not, and the
  // gap it closes is precisely the one wb_canvas_edit cannot cross.
  const noteForThreads = await createDocument({
    path: 'smoke/threaded-note',
    kind: 'markdown',
  })
  const noteId = noteForThreads.documentId
  const opened = await callTool('wb_thread_edit', {
    workspaceId: WORKSPACE_ID,
    documentId: noteId,
    ops: [
      {
        op: 'thread.add',
        anchor: { kind: 'text', quote: { exact: 'threaded' }, start: 0, end: 8 },
        body: 'smoke thread',
        author: 'agent:smoke',
      },
    ],
  })
  const threadId = opened.threads?.[0]?.id
  if (threadId === undefined || opened.threads[0]?.messageCount !== 1) {
    throw new Error(`thread.add did not report its thread: ${JSON.stringify(opened)}`)
  }
  const replied = await callTool('wb_thread_edit', {
    workspaceId: WORKSPACE_ID,
    documentId: noteId,
    ops: [{ op: 'message.add', threadId, body: 'smoke reply' }],
  })
  if (replied.threads?.[0]?.messageCount !== 2) {
    throw new Error(`message.add did not append: ${JSON.stringify(replied)}`)
  }
  const closed = await callTool('wb_thread_edit', {
    workspaceId: WORKSPACE_ID,
    documentId: noteId,
    ops: [{ op: 'thread.resolve', threadId }],
  })
  if (closed.threads?.[0]?.status !== 'resolved') {
    throw new Error(`thread.resolve did not close the thread: ${JSON.stringify(closed)}`)
  }
  console.log('[e2e] wb_thread_edit → thread.add / message.add / thread.resolve on a markdown note')

  // The two references a spatial anchor may carry beyond a node, and the
  // text arm naming a node: an EDGE comment, and a comment on a passage of
  // a node's text. Both reach canvas_view through the projection — the edge
  // one carrying its edge, the passage one standing at its node — which is
  // what the widget draws pins from, and what no unit test of the tool sees.
  const anchoredOnCanvas = await callTool('wb_thread_edit', {
    workspaceId: viewed.workspaceId,
    documentId: viewed.documentId,
    ops: [
      {
        op: 'thread.add',
        threadId: 'smoke-edge-thread',
        anchor: { kind: 'spatial', edgeId: 'link', x: 100, y: 50 },
        body: 'about this connection',
        author: 'agent:smoke',
      },
      {
        op: 'thread.add',
        threadId: 'smoke-passage-thread',
        anchor: { kind: 'text', nodeId: 'lockable', quote: { exact: 'lock' }, start: 0, end: 4 },
        body: 'about this word',
        author: 'agent:smoke',
      },
      // The three anchors with no single object: a node set, a bare
      // region, and the document itself.
      {
        op: 'thread.add',
        threadId: 'smoke-set-thread',
        anchor: {
          kind: 'spatial',
          nodeIds: ['lockable', 'target'],
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        body: 'about these two',
        author: 'agent:smoke',
      },
      {
        op: 'thread.add',
        threadId: 'smoke-region-thread',
        anchor: { kind: 'spatial', x: 600, y: 600, width: 200, height: 100 },
        body: 'about this empty corner',
        author: 'agent:smoke',
      },
      {
        op: 'thread.add',
        threadId: 'smoke-document-thread',
        anchor: { kind: 'document' },
        body: 'about the whole canvas',
        author: 'agent:smoke',
      },
    ],
  })
  if (anchoredOnCanvas.threads?.length < 6) {
    throw new Error(`thread.add on the canvas did not report: ${JSON.stringify(anchoredOnCanvas)}`)
  }
  const afterAnchors = await callTool('canvas_view', { workspaceId: WORKSPACE_ID, documentId })
  const projected = afterAnchors.scene['x-whiteboard']?.comments ?? []
  const edgeProjected = projected.find((c) => c.id === 'smoke-edge-thread')
  const passageProjected = projected.find((c) => c.id === 'smoke-passage-thread')
  if (edgeProjected?.targetEdgeId !== 'link') {
    throw new Error(`an edge thread did not project with its edge: ${JSON.stringify(projected)}`)
  }
  if (passageProjected?.targetNodeId !== 'lockable') {
    throw new Error(`a node passage did not project onto its node: ${JSON.stringify(projected)}`)
  }
  // A region projects to its top-right corner; the document arm projects to
  // nothing (the panel is its only surface) — and every thread reaches the
  // widget whole through `threads`, which is what draws the outline.
  const regionProjected = projected.find((c) => c.id === 'smoke-region-thread')
  if (regionProjected?.x !== 800 || regionProjected?.y !== 600) {
    throw new Error(`a region did not project to its corner: ${JSON.stringify(regionProjected)}`)
  }
  if (projected.some((c) => c.id === 'smoke-document-thread')) {
    throw new Error('a document-level thread projected onto the canvas')
  }
  const widgetThreadIds = (afterAnchors.threads ?? []).map((t) => t.id)
  for (const id of ['smoke-set-thread', 'smoke-region-thread', 'smoke-document-thread']) {
    if (!widgetThreadIds.includes(id)) {
      throw new Error(`canvas_view did not carry thread ${id}: ${JSON.stringify(widgetThreadIds)}`)
    }
  }
  console.log(
    '[e2e] wb_thread_edit → edge, node-passage, node-set, region and document threads reach canvas_view',
  )

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

  // The two arms wb_body_patch had, now as ops. Only a real MCP SDK client
  // can prove the registered schema accepts them — this is what tools/list
  // validates arguments against — and the result is read back through
  // wb_canvas_snapshot rather than the tool's own echo, so persistence is
  // what is checked.
  await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    mode: 'apply',
    ops: [{ op: 'node.patch', id: 'target', patch: { text: 'line0\nline1\nline2' } }],
  })
  await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    mode: 'apply',
    ops: [{ op: 'node.splice', id: 'target', startLine: 1, endLine: 1, replacement: 'patched' }],
  })
  const afterPatch = await callTool('wb_canvas_snapshot', { workspaceId: WORKSPACE_ID, documentId })
  const patchedNode = Array.isArray(afterPatch.nodes)
    ? afterPatch.nodes.find((node) => node.id === 'target')
    : undefined
  if (patchedNode?.text !== 'line0\npatched\nline2') {
    throw new Error(`node.patch/node.splice did not persist: ${JSON.stringify(patchedNode)}`)
  }
  console.log('[e2e] wb_canvas_edit → node.patch(text) then node.splice, persisted')

  // The silent no-op that retiring wb_body_patch into node.patch had to
  // close first: `label` is on the patch allowlist because a GROUP has one,
  // and the per-type node schemas are non-strict, so before the guard this
  // reported success over a document it did not change.
  await expectToolError(
    'wb_canvas_edit',
    {
      workspaceId: WORKSPACE_ID,
      documentId,
      mode: 'apply',
      ops: [{ op: 'node.patch', id: 'target', patch: { label: 'not for a text node' } }],
    },
    'patching a group-only key onto a text node',
    'has no label',
  )
  console.log('[e2e] wb_canvas_edit → a key the node type lacks is refused, not dropped')

  // wb_canvas_edit is the whole spatial-mutation surface, so the smoke has
  // to reach the parts a unit test cannot: the batch's structuredContent vs
  // its outputSchema through the real MCP SDK, and — because this tool
  // decides ids and coordinates the caller never supplied — that what it
  // REPORTS placing is what it actually stored.
  const applied = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    mode: 'apply',
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
  // the full reconcile through the real wire: add two inside, name both,
  // then name one, and the other must be gone. The group sits far from everything else so
  // nothing already on this canvas is enclosed by it.
  await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    mode: 'apply',
    ops: [
      {
        op: 'node.add',
        node: { id: 'region', type: 'group', x: 5000, y: 5000, width: 900, height: 600 },
      },
      { op: 'node.add', node: { id: 'in-1', type: 'text', text: 'first' }, within: 'region' },
      { op: 'node.add', node: { id: 'in-2', type: 'text', text: 'second' }, within: 'region' },
      { op: 'region.set', within: 'region', nodes: ['in-1', 'in-2'] },
    ],
    follow: false,
  })
  const reconciled = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    mode: 'apply',
    ops: [{ op: 'region.set', within: 'region', nodes: ['in-1'] }],
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
  // A selector where an id goes: `within` names the group, not its members.
  const lockedRegion = await callTool('wb_canvas_edit', {
    workspaceId: WORKSPACE_ID,
    documentId,
    mode: 'apply',
    ops: [{ op: 'node.lock', within: 'region', locked: true }],
    follow: false,
  })
  const lockedIds = lockedRegion.snapshot.nodes.filter((node) => node.locked).map((node) => node.id)
  if (!lockedIds.includes('in-1') || lockedIds.includes('lockable')) {
    throw new Error(`node.lock within reached the wrong nodes: ${JSON.stringify(lockedIds)}`)
  }
  console.log("[e2e] wb_canvas_edit(node.lock within) → only the region's member locked")

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
    mode: 'apply',
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
    mode: 'apply',
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

  // wb_version_save — into the SAME history the History panel lists, so the
  // answer is the panel's row shape.
  const saved = await callTool('wb_version_save', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    label: 'e2e',
  })
  const savedRow = saved.saved[0]
  if (
    savedRow?.documentId !== documentId ||
    !savedRow.version?.id ||
    savedRow.version.label !== 'e2e' ||
    savedRow.version.auto !== false ||
    !savedRow.version.createdAt ||
    savedRow.version.operator?.kind !== 'ai'
  ) {
    throw new Error(`wb_version_save returned unexpected shape: ${JSON.stringify(saved)}`)
  }
  console.log(`[e2e] wb_version_save → ${savedRow.version.id}`)

  // Axis B on a write: one call, one shared label, two documents. The
  // batch also proves the write lock nests without deadlocking, which no
  // unit test of the tool alone can show.
  const batchSaved = await callTool('wb_version_save', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId, named.documentId],
    label: 'one checkpoint, two documents',
  })
  if (
    batchSaved.saved.map((entry) => entry.documentId).join() !==
    [documentId, named.documentId].join()
  ) {
    throw new Error(
      `wb_version_save did not answer in the order asked: ${JSON.stringify(batchSaved.saved.map((entry) => entry.documentId))}`,
    )
  }
  if (batchSaved.saved.some((entry) => entry.version.label !== 'one checkpoint, two documents')) {
    throw new Error(`wb_version_save did not share the label: ${JSON.stringify(batchSaved.saved)}`)
  }
  console.log('[e2e] wb_version_save → two documents, one label, one call')

  // wb_version_list
  const listed = await callTool('wb_version_list', { workspaceId: WORKSPACE_ID, documentId })
  if (
    listed.documentId !== documentId ||
    !Array.isArray(listed.versions) ||
    !listed.versions.some((v) => v.id === savedRow.version.id)
  ) {
    throw new Error(`wb_version_list missing the saved id: ${JSON.stringify(listed)}`)
  }
  console.log(`[e2e] wb_version_list → ${listed.versions.length} version(s)`)

  // wb_version_restore
  const restored = await callTool('wb_version_restore', {
    workspaceId: WORKSPACE_ID,
    documentId,
    versionId: savedRow.version.id,
  })
  if (
    restored.mode !== 'in-place' ||
    restored.documentId !== documentId ||
    restored.restoredVersionId !== savedRow.version.id ||
    restored.label !== 'e2e'
  ) {
    throw new Error(`wb_version_restore returned unexpected shape: ${JSON.stringify(restored)}`)
  }
  console.log(`[e2e] wb_version_restore → ${restored.restoredVersionId}`)

  // wb_version_restore into a targetPath — the copy mode, so the
  // structuredContent for the into-target shape is validated at runtime too.
  const copied = await callTool('wb_version_restore', {
    workspaceId: WORKSPACE_ID,
    documentId,
    versionId: savedRow.version.id,
    targetPath: 'e2e-restored-copy',
  })
  if (
    copied.mode !== 'into-target' ||
    copied.targetPath !== 'e2e-restored-copy' ||
    typeof copied.elementCount !== 'number'
  ) {
    throw new Error(
      `wb_version_restore(targetPath) returned unexpected shape: ${JSON.stringify(copied)}`,
    )
  }
  await expectToolError(
    'wb_version_restore',
    {
      workspaceId: WORKSPACE_ID,
      documentId,
      versionId: savedRow.version.id,
      targetPath: 'e2e-restored-copy',
    },
    'into a targetPath that already exists',
    'already exists',
  )
  console.log(
    `[e2e] wb_version_restore(targetPath) → ${copied.targetPath} (${copied.elementCount} node(s))`,
  )

  // wb_version_restore with subtree — the THIRD of this tool's output
  // shapes, and the one nothing reached. `in-place` and `into-target` are
  // asserted above, so a drift in `restoredCount` was the one field of the
  // three that could ship with every gate green: the MCP SDK validates
  // structuredContent against outputSchema only on shapes something calls.
  //
  // The subtree is addressed by PATH PREFIX (`p === path || p.startsWith(
  // `${path}/`)`), so the fixture needs a real descendant rather than a
  // second sibling.
  const treeRoot = await createDocument({
    path: 'e2e-tree',
    kind: 'markdown',
    markdown: '---\ntype: note\n---\nroot at the saved point',
  })
  const treeChild = await createDocument({
    path: 'e2e-tree/child',
    kind: 'markdown',
    markdown: '---\ntype: note\n---\nchild at the saved point',
  })
  const treeVersion = await callTool('wb_version_save', {
    workspaceId: WORKSPACE_ID,
    documentIds: [treeRoot.documentId],
    label: 'e2e-subtree-point',
  })
  // Move the DESCENDANT away from the saved state. Asserting the rollback
  // reached it is what makes this step about the mode rather than only its
  // shape — a subtree restore that quietly touched the addressed document
  // alone would satisfy every field above.
  await setDocument({
    documentId: treeChild.documentId,
    markdown: '---\ntype: note\n---\nchild after the saved point',
  })
  const rolledBack = await callTool('wb_version_restore', {
    workspaceId: WORKSPACE_ID,
    documentId: treeRoot.documentId,
    versionId: treeVersion.saved[0].version.id,
    subtree: true,
  })
  if (rolledBack.mode !== 'subtree' || rolledBack.restoredCount !== 2) {
    throw new Error(
      `wb_version_restore(subtree) returned unexpected shape: ${JSON.stringify(rolledBack)}`,
    )
  }
  const childAfter = await readDocument(treeChild.documentId)
  if (!childAfter.content.includes('child at the saved point')) {
    throw new Error(
      `subtree rollback did not reach the descendant: ${JSON.stringify(childAfter.content)}`,
    )
  }
  await expectToolError(
    'wb_version_restore',
    {
      workspaceId: WORKSPACE_ID,
      documentId: treeRoot.documentId,
      versionId: treeVersion.saved[0].version.id,
      subtree: true,
      targetPath: 'e2e-tree-elsewhere',
    },
    'with subtree AND a distinct targetPath',
    'cannot take a targetPath',
  )
  console.log(
    `[e2e] wb_version_restore(subtree) → ${rolledBack.restoredCount} document(s) rolled back`,
  )

  // document.set → wb_document_get round-trip, including the core
  // facets (type/title/tags) — these are stored via writeCoreFacets, a
  // separate code path from the extension `facets` bucket below, so this is
  // the runtime guard for structuredContent-vs-outputSchema drift on both.
  // A MARKDOWN document for the OKF round-trip. The spatial one above reads
  // back as JSON Canvas now, so asking it for frontmatter would be asking a
  // diagram for its markdown — exactly what wb_document_get stopped doing.
  const mdCreated = await createDocument({ path: 'e2e-okf', kind: 'markdown' })
  const mdCanvasId = mdCreated.documentId

  // A write in the format the document is not in destroys rather than
  // fails: OKF into the spatial one replaces its nodes, a node into the
  // markdown one lands beside the text node holding its body.
  await expectToolError(
    'wb_workspace_edit',
    {
      workspaceId: WORKSPACE_ID,
      ops: [{ op: 'document.set', documentId, markdown: '---\ntype: note\n---\nBody.' }],
    },
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

  // `status` is an OKF root key this server does not model; it rides along so
  // the round trip below proves the preservation rule at runtime, where the
  // MCP SDK validates structuredContent against outputSchema and a bucket the
  // schema does not admit fails here and only here. `description` is modelled,
  // so it comes back as a field. The write declares no `generated`, so the
  // server stamps the `actor` passed below.
  const importMarkdown = [
    '---',
    'type: issue',
    'title: "Smoke test issue"',
    'tags:',
    '  - smoke',
    '  - e2e',
    'description: An issue written by the e2e smoke.',
    'status: stable',
    'facets:',
    '  example.sample/v1:',
    '    status: open',
    '---',
    'Imported body.',
  ].join('\n')
  const imported = await setDocument(
    { documentId: mdCanvasId, markdown: importMarkdown },
    { actor: 'process:mcp-e2e-smoke' },
  )
  if (imported.applied !== 1 || imported.results[0].documentId !== mdCanvasId) {
    throw new Error(`document.set returned unexpected shape: ${JSON.stringify(imported)}`)
  }
  console.log('[e2e] document.set → imported')

  // wb_document_search over the body just imported — the runtime guard for
  // this tool's structuredContent-vs-outputSchema drift, plus tag filtering.
  const searched = await callTool('wb_document_search', {
    workspaceId: WORKSPACE_ID,
    query: 'Imported body',
    tags: ['smoke'],
  })
  if (!searched.results.some((r) => r.documentId === mdCanvasId)) {
    throw new Error(`wb_document_search missed the imported document: ${JSON.stringify(searched)}`)
  }
  if (!(searched.results[0].contexts[0] ?? '').includes('Imported body')) {
    throw new Error(`wb_document_search snippet mismatch: ${JSON.stringify(searched.results[0])}`)
  }
  // The rank a caller uses to decide whether `contexts` is a match to
  // highlight or just an opening excerpt. This daemon has no embedder, so
  // every hit is lexical and none carries a semantic rank — the shape a
  // client sees by default, and the one that must survive schema drift.
  if (searched.results[0].lexicalRank !== 1) {
    throw new Error(
      `wb_document_search lexicalRank mismatch: ${JSON.stringify(searched.results[0])}`,
    )
  }
  if (searched.results.some((r) => r.semanticRank !== undefined)) {
    throw new Error(`wb_document_search reported a semantic rank with no embedder configured`)
  }
  console.log('[e2e] wb_document_search → found the imported body, snippet and lexical rank')

  const exported = await readDocument(mdCanvasId)
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
  // The trust family is MODELLED, so it comes back as a typed field rather
  // than in the preserved bucket, and `at` is the server's clock.
  const generated = exported.frontmatter.generated
  if (generated?.by !== 'process:mcp-e2e-smoke' || !Number.isFinite(Date.parse(generated?.at))) {
    throw new Error(
      `document.set did not stamp the declared actor: ${JSON.stringify(exported.frontmatter)}`,
    )
  }
  if (exported.frontmatter.description !== 'An issue written by the e2e smoke.') {
    throw new Error(
      `modelled OKF description did not survive: ${JSON.stringify(exported.frontmatter)}`,
    )
  }
  const preserved = exported.frontmatter.facetsRaw
  if (preserved?.status !== 'stable') {
    throw new Error(
      `unmodelled OKF root keys were not preserved: ${JSON.stringify(exported.frontmatter)}`,
    )
  }
  if (!exported.content.includes('\nstatus: stable\n') || exported.content.includes('facetsRaw:')) {
    throw new Error(
      `preserved OKF keys were not re-emitted at the frontmatter root: ${exported.content}`,
    )
  }
  console.log(
    '[e2e] wb_document_get → generated stamped from the declared actor, unmodelled OKF keys preserved at the root',
  )
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
