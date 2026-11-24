import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

/**
 * `wb_facet_list` as the daemon answers it: the recording the Rust ops
 * layer's `FacetList` is replayed against
 * (`crates/adapters/mcp/tests/facet_list.rs`).
 *
 * `oracle/facet-list.jsonl` opens with one record row: the one workspace's
 * record (`snapshot`, kept as `W`), the registry rows that address it, the
 * caller's namespace and the handles a refusal may name. The record was built
 * once through the daemon's own tools: a stencil library and a tag library at
 * their well-known paths, a note, a board, a node and an edge carrying tags,
 * and a document whose tags are another's. Delete the file to build it again
 * (the ids are minted, though no answer names one).
 *
 * Every row after it is one `tools/call` and the result it drew, answered
 * over a fresh data directory the record was loaded into, its
 * `structuredContent` held as `structured: true` once it is shown to be what
 * its text spells. Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node facet-list.oracle`.
 */
const FIXTURE = new URL('./oracle/facet-list.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'
const KNOWN = [SEGMENT]

const tmp = withTempDataDir('whiteboard-mcp-facet-list-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  getDataDir: () => join(tmp.dir, 'data'),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

// lazy-import: the server and its deps are imported after `vi.mock` replaces
// `../config.js`, so they read this file's temporary data directory.
const { createMcpServer } = await import('./server.js')
const { resolveTestServerDeps } = await import('../routes/_test-helpers.js')
const { importWorkspaceRecord, workspaceRecordCopy } = await import(
  '../store/_test-workspace-record.js'
)

type Message = Record<string, unknown>

/** Raw JSON-RPC against a server: each request's answer as the wire carries it. */
async function session(server: McpServer): Promise<(message: Message) => Promise<Message>> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const waiting = new Map<unknown, (answer: Message) => void>()
  clientSide.onmessage = (answer) => {
    const { id } = answer as { id?: unknown }
    waiting.get(id)?.(answer as Message)
    waiting.delete(id)
  }
  await clientSide.start()
  let id = 0
  return (message) =>
    new Promise((resolve) => {
      id += 1
      waiting.set(id, resolve)
      void clientSide.send({ jsonrpc: '2.0', id, ...message } as never)
    })
}

/** A `tools/call`, answered with its result or its JSON-RPC error. */
type Call = (name: string, args?: Message) => Promise<Message>

async function caller(deps: ServerDeps): Promise<Call> {
  const send = await session(await createMcpServer(deps))
  return async (name, args) => {
    const params = args === undefined ? { name } : { name, arguments: args }
    const answer = await send({ method: 'tools/call', params })
    return (answer.result as Message | undefined) ?? { error: answer.error }
  }
}

async function freshDeps(known: string[]): Promise<ServerDeps> {
  const deps = await resolveTestServerDeps(join(tmp.dir, 'data'))
  await deps.documentIndex.createWorkspace({ workspaceId: W, segment: SEGMENT })
  return { ...deps, knownWorkspaceHandles: async () => known }
}

/** The structured answer of a call that must succeed. */
async function ok(call: Call, name: string, args: Message): Promise<Message> {
  const answer = await call(name, args)
  if (answer.isError === true || answer.error !== undefined) {
    throw new Error(`${name} failed while building the record: ${JSON.stringify(answer)}`)
  }
  return answer.structuredContent as Message
}

const STENCILS = {
  ledger: { displayName: 'Ledger' },
  lakehouse: {
    displayName: 'Lakehouse',
    color: '3',
    facets: { 'visual.shape/v0': { kind: 'cylinder' } },
  },
  'api-gateway': { displayName: 'API gateway', color: '#1a2b3c' },
}

const TAG_KEYS = {
  team: {},
  health: {
    description: 'How a service is doing.',
    exclusive: true,
    values: {
      ok: { color: '4' },
      failing: { color: '1', description: 'Down or erroring.' },
      degraded: { description: 'Slow.' },
    },
  },
  owner: { exclusive: false, values: { ana: {} } },
}

/** Documents, tags and the two libraries, written through the tools. */
async function populate(call: Call): Promise<void> {
  const created = await ok(call, 'wb_workspace_edit', {
    workspaceId: W,
    ops: [
      { op: 'document.create', path: 'note', kind: 'markdown', markdown: '# Note\n' },
      { op: 'document.create', path: 'other', kind: 'markdown', markdown: 'tagged too' },
      { op: 'document.create', path: 'board', kind: 'spatial' },
      { op: 'document.create', path: 'stencils', kind: 'markdown' },
      { op: 'document.create', path: 'tags', kind: 'markdown' },
    ],
  })
  const ids: Record<string, string> = {}
  for (const result of created.results as { path: string; documentId: string }[]) {
    ids[result.path] = result.documentId
  }
  const board = ids.board as string
  await ok(call, 'wb_canvas_edit', {
    workspaceId: W,
    documentId: board,
    mode: 'apply',
    ops: [
      { op: 'node.add', node: { id: 'a', type: 'text', text: 'API', x: 0, y: 0 } },
      { op: 'node.add', node: { id: 'b', type: 'text', text: 'DB', x: 300, y: 0 } },
      { op: 'node.add', node: { id: 'c', type: 'text', text: 'Cache', x: 0, y: 300 } },
      { op: 'edge.add', edge: { id: 'e', from: { node: 'a' }, to: { node: 'b' } } },
    ],
  })
  const tag = (documentIds: string[], add: string[], at: Message = {}) =>
    ok(call, 'wb_facet_set', { workspaceId: W, documentIds, tags: { add }, ...at })
  await tag([ids.note as string, ids.other as string], ['health:failing', 'ml'])
  await tag([ids.other as string], ['team:core', 'ml'])
  await tag([board], ['team:core', 'zeta'])
  await tag([board], ['health:ok', 'team:core', 'health:degraded'], { nodeId: 'a' })
  await tag([board], ['health:ok'], { nodeId: 'b' })
  await tag([board], ['owner:ana', 'ml'], { edgeId: 'e' })
  await ok(call, 'wb_facet_set', {
    workspaceId: W,
    documentIds: [ids.stencils as string],
    facets: { 'visual.stencils/v0': { stencils: STENCILS } },
  })
  await ok(call, 'wb_facet_set', {
    workspaceId: W,
    documentIds: [ids.tags as string],
    facets: { 'visual.tags/v0': { keys: TAG_KEYS } },
  })
}

/** The record the calls are answered over, built through the tools. */
async function buildRecord(): Promise<Message> {
  const deps = await freshDeps(KNOWN)
  await populate(await caller(deps))
  const record = await workspaceRecordCopy(W)
  const registry = (await deps.documentIndex.listWorkspaces()).filter(
    (row) => row.workspaceId === W,
  )
  return {
    case: 'deployment',
    snapshot: bytesToBase64(record.export({ mode: 'snapshot' })),
    registry,
    callerNamespace: (await deps.callerNamespace?.()) ?? 'me',
    known: KNOWN,
  }
}

const TARGETS = ['document', 'canvas', 'node', 'edge']
const ASSET_KINDS = ['themes', 'icons', 'stencils']

/** The lists the recording answers, by what each one is about. */
function listCalls(): [string, Message | undefined][] {
  return [
    ['no arguments', undefined],
    ['empty arguments', {}],
    ...TARGETS.map((target): [string, Message] => [`target ${target}`, { target }]),
    ...ASSET_KINDS.map((assetKind): [string, Message] => [`assets ${assetKind}`, { assetKind }]),
    ['a target and an asset kind', { target: 'edge', assetKind: 'themes' }],
  ]
}

/** Calls naming a workspace: resolved first, as every tool resolves one. */
function workspaceCalls(): [string, Message | undefined][] {
  return [
    ['a workspace by id', { workspaceId: W }],
    ['a workspace by segment, filtered', { workspaceId: SEGMENT, target: 'node' }],
    ['a workspace by namespace and segment', { workspaceId: `me/${SEGMENT}` }],
    ['a workspace, its stencils alone', { workspaceId: W, assetKind: 'stencils' }],
    ['a workspace, filtered to the canvas', { workspaceId: W, target: 'canvas' }],
    ['a workspace nothing answers to', { workspaceId: 'nope' }],
    ['an id nothing answers to', { workspaceId: '01BX5ZZKBKACTAV9WEVGEMMVRZ' }],
    ['an empty address', { workspaceId: '' }],
    ['an address no form spells', { workspaceId: 'a_b/c/d', assetKind: 'icons' }],
  ]
}

/** Arguments the SDK refuses before the tool runs. */
function validationCalls(): [string, Message | undefined][] {
  return [
    ['a target the engine has not', { target: 'workspace' }],
    ['a target not a string', { target: 1 }],
    ['a null target', { target: null }],
    ['an asset kind the engine has not', { assetKind: 'fonts' }],
    ['a workspace not a string', { workspaceId: 7 }],
    ['an unknown key', { kind: 'node' }],
    ['every field wrong', { target: 'Node', assetKind: [], workspaceId: {}, extra: 1 }],
  ]
}

/**
 * A result with its `structuredContent` left out once it is shown to be what
 * its text spells, which is how the tool wrapper writes the text.
 */
function textOnly(answer: Message): Message {
  const { structuredContent, ...rest } = answer
  if (structuredContent === undefined) return answer
  const [first] = answer.content as { text: string }[]
  expect(first?.text).toBe(JSON.stringify(structuredContent))
  return { ...rest, structured: true }
}

const exists = (file: URL) =>
  access(file).then(
    () => true,
    () => false,
  )

async function rowsOf(file: URL): Promise<Message[]> {
  return (await readFile(file, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Message)
}

/** Every call, answered by a daemon the record was loaded into. */
async function answer(record: Message): Promise<Message[]> {
  const deps = await freshDeps(KNOWN)
  await importWorkspaceRecord(
    W,
    LoroDoc.fromSnapshot(base64ToBytes(record.snapshot as string) as Uint8Array),
  )
  const call = await caller(deps)
  const rows: Message[] = [record]
  for (const [about, args] of [...listCalls(), ...workspaceCalls(), ...validationCalls()]) {
    const params =
      args === undefined ? { name: 'wb_facet_list' } : { name: 'wb_facet_list', arguments: args }
    rows.push({ case: about, params, answer: textOnly(await call('wb_facet_list', args)) })
  }
  return rows
}

describe('wb_facet_list over a workspace with libraries and tags', () => {
  it('answers every recorded call as the recording holds it', { timeout: 120_000 }, async () => {
    const held = (await exists(FIXTURE)) ? (await rowsOf(FIXTURE))[0] : undefined
    const record = held?.snapshot === undefined ? await buildRecord() : held
    const answered = await answer(record)
    if (RECORD || held?.snapshot === undefined) {
      await writeFile(FIXTURE, `${answered.map((row) => JSON.stringify(row)).join('\n')}\n`)
    }
    expect(await rowsOf(FIXTURE)).toEqual(answered)
  })
})
