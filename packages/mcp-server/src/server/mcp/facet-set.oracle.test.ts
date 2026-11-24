import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { AgentActivity, ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc, LoroList, type LoroMap, type LoroTree } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

/**
 * `wb_facet_set` as the daemon answers it: the recording the Rust ops
 * layer's `FacetSet` is replayed against
 * (`crates/adapters/mcp/tests/facet_set.rs`).
 *
 * `oracle/facet-set.jsonl` opens with one record row: a workspace record
 * (`snapshot`, kept as `W`) holding a note, a board with tagged and locked
 * elements, an empty board and one in a shape no tool writes any more, the
 * registry rows that address it, the caller's namespace, the handles a
 * refusal may name, the ids of its documents by name, and the scripting:
 * `peer`, the replica every record the daemon opens writes as, and `mint`,
 * the one instant every write is stamped at (as text and as milliseconds).
 * The record's peer is drawn from `crypto.getRandomValues` and the stamps
 * from `Date`, and both are replaced while the calls are answered, so a rerun
 * writes the same operations.
 *
 * Every row after the second is one `tools/call`, the result it drew, the
 * activity it announced to a watching page, the documents it reported
 * written, and the stored record after it when the call moved it (its value,
 * version vector and frontiers), answered in order over a fresh data
 * directory the record was loaded into. Re-record after a deliberate change
 * with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node facet-set.oracle`.
 */
const FIXTURE = new URL('./oracle/facet-set.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'
const NOTHING = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const MINT_AT = '2026-11-24T12:00:00.000Z'
const PEER = 4_242_424_242

const served = vi.hoisted(() => ({ dir: 'build' }))

const tmp = withTempDataDir('whiteboard-mcp-facet-set-')

const dataDir = () => join(tmp.dir, served.dir)

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return dataDir()
  },
  getDataDir: () => dataDir(),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

// lazy-import: the server and its deps are imported after `vi.mock` replaces
// `../config.js`, so they read this file's temporary data directory.
const { createMcpServer } = await import('./server.js')
const { resolveTestServerDeps } = await import('../routes/_test-helpers.js')
const { editWorkspaceRecord, importWorkspaceRecord, workspaceRecordCopy } = await import(
  '../store/_test-workspace-record.js'
)

afterEach(() => {
  served.dir = 'build'
  vi.useRealTimers()
  vi.restoreAllMocks()
})

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

/** What a call told the watching pages and the write observer. */
interface Heard {
  activity: AgentActivity[]
  written: Message[]
}

async function freshDeps(known: string[], heard?: Heard): Promise<ServerDeps> {
  const deps = await resolveTestServerDeps(dataDir())
  await deps.documentIndex.createWorkspace({ workspaceId: W, segment: SEGMENT })
  if (heard === undefined) return { ...deps, knownWorkspaceHandles: async () => known }
  const notifier = {
    agentActivity: (activity: AgentActivity) => {
      heard.activity.push(activity)
    },
    requestViewport: async () => false,
    versionCreated: () => {},
    restoreProgress: () => {},
  }
  return {
    ...deps,
    knownWorkspaceHandles: async () => known,
    clientNotifier: notifier,
    documentWritten: async (written) => {
      heard.written.push({ ...written })
    },
  }
}

/** One call during the build, which must land. */
async function landed(call: Call, name: string, args: Message): Promise<Message> {
  const answer = await call(name, args)
  if (answer.isError === true || answer.error !== undefined) {
    throw new Error(`${name} did not land: ${JSON.stringify(answer)}`)
  }
  return answer.structuredContent as Message
}

const DOCUMENTS: Message[] = [
  {
    op: 'document.create',
    path: 'note',
    kind: 'markdown',
    markdown: '---\ntype: note\ntags:\n  - draft\n  - env:dev\n---\nbody\n',
  },
  {
    op: 'document.create',
    path: 'second',
    kind: 'markdown',
    markdown: '---\ntype: note\n---\nb\n',
  },
  {
    op: 'document.create',
    path: 'crowded',
    kind: 'markdown',
    markdown: '---\ntype: note\n---\nc\n',
  },
  { op: 'document.create', path: 'tags', kind: 'markdown', markdown: '---\ntype: note\n---\nl\n' },
  { op: 'document.create', path: 'board', kind: 'spatial' },
  { op: 'document.create', path: 'empty', kind: 'spatial' },
  { op: 'document.create', path: 'elderly', kind: 'spatial' },
]

const BOARD_OPS: Message[] = [
  { op: 'node.add', node: { id: 'pad', type: 'text', text: 'Launch pad', x: 0, y: 0 } },
  { op: 'node.add', node: { id: 'tower', type: 'text', text: 'Tower', x: 300, y: 0 } },
  { op: 'node.add', node: { id: 'vault', type: 'text', text: 'Vault', x: 0, y: 200 } },
  { op: 'edge.add', edge: { id: 'fuels', from: { node: 'pad' }, to: { node: 'tower' } } },
  { op: 'edge.add', edge: { id: 'sealed', from: { node: 'pad' }, to: { node: 'vault' } } },
  { op: 'node.lock', id: 'vault', locked: true },
  { op: 'edge.lock', id: 'sealed', locked: true },
]

/** The tags the board's elements carry before any call, written through the tool. */
const TAGGED: Message[] = [
  { nodeId: 'pad', tags: { add: ['health:ok', 'plain'] } },
  { nodeId: 'tower', tags: { add: ['health:failing'] } },
  { edgeId: 'fuels', tags: { add: ['plain'] } },
]

/** The tool's tags on the board's locked vault and sealed edge, before they were locked. */
const LOCKED_TAGS: Message[] = [
  { nodeId: 'vault', tags: { add: ['plain'] } },
  { edgeId: 'sealed', tags: { add: ['plain'] } },
]

async function populate(call: Call): Promise<Record<string, string>> {
  const created = await landed(call, 'wb_workspace_edit', {
    workspaceId: W,
    actor: 'claude-code/2.1',
    ops: DOCUMENTS,
  })
  const ids: Record<string, string> = {}
  for (const result of created.results as { path: string; documentId: string }[]) {
    ids[result.path] = result.documentId
  }
  const lockOps = BOARD_OPS.filter((op) => String(op.op).endsWith('.lock'))
  await landed(call, 'wb_canvas_edit', {
    workspaceId: W,
    documentId: ids.board,
    mode: 'apply',
    ops: BOARD_OPS.filter((op) => !lockOps.includes(op)),
  })
  for (const more of [...TAGGED, ...LOCKED_TAGS]) {
    await landed(call, 'wb_facet_set', { workspaceId: W, documentIds: [ids.board], ...more })
  }
  await landed(call, 'wb_canvas_edit', {
    workspaceId: W,
    documentId: ids.board,
    mode: 'apply',
    ops: lockOps,
  })
  return ids
}

/** The tree node meta map that hosts `documentId`. */
function hostOf(copy: LoroDoc, documentId: string): LoroMap {
  const tree = copy.getTree('tree') as LoroTree
  const node = tree.getNodes().find((each) => each.data.get('documentId') === documentId)
  if (node === undefined) throw new Error(`no node hosts ${documentId}`)
  return node.data
}

/** What no tool writes any more: `elderly` holds its elements in the retired `elements` list. */
function retire(copy: LoroDoc, ids: Record<string, string>): void {
  const elements = hostOf(copy, ids.elderly ?? '').setContainer('elements', new LoroList())
  elements.push({ id: 'e1', type: 'rectangle' })
}

async function buildRecord(): Promise<Message> {
  const known = [SEGMENT]
  const deps = await freshDeps(known)
  const ids = await populate(await caller(deps))
  await editWorkspaceRecord(W, (copy) => retire(copy, ids))
  const record = await workspaceRecordCopy(W)
  const registry = (await deps.documentIndex.listWorkspaces()).filter(
    (row) => row.workspaceId === W,
  )
  return {
    case: 'board',
    snapshot: bytesToBase64(record.export({ mode: 'snapshot' })),
    registry,
    callerNamespace: (await deps.callerNamespace?.()) ?? 'me',
    known,
    ids,
    peer: String(PEER),
    mint: { at: MINT_AT, atMs: Date.parse(MINT_AT) },
  }
}

type Ids = Record<string, string>
type Asked = [string, Message | undefined]

const manyTags = (count: number, prefix = 't') =>
  Array.from({ length: count }, (_, at) => `${prefix}${at}`)

/** Writes the tool answers, one document and site at a time. */
function noteCalls(ids: Ids): Asked[] {
  const note = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.note], ...more })
  return [
    ['a tag added to a note', note({ tags: { add: ['reviewed'] } })],
    ['a tag added twice is kept once', note({ tags: { add: ['reviewed', 'reviewed'] } })],
    ['a tag already present', note({ tags: { add: ['draft'] } })],
    ['a tag removed by name', note({ tags: { remove: ['draft'] } })],
    ['a tag removed that is not there', note({ tags: { remove: ['nothing'] } })],
    ['a scoped tag added', note({ tags: { add: ['health:ok'] } })],
    ['a tag renamed', note({ tags: { rename: [{ from: 'env:dev', to: 'env:prod' }] } })],
    [
      'a rename onto a present tag merges',
      note({ tags: { rename: [{ from: 'reviewed', to: 'health:ok' }] } }),
    ],
    [
      'the first of two renames of one tag',
      note({
        tags: {
          rename: [
            { from: 'health:ok', to: 'a' },
            { from: 'health:ok', to: 'b' },
          ],
        },
      }),
    ],
    [
      'a rename and a removal of the new spelling',
      note({ tags: { rename: [{ from: 'a', to: 'z' }], remove: ['z'] } }),
    ],
    [
      'every tag removed',
      note({ tags: { remove: ['draft', 'env:prod', 'b', 'z', 'reviewed', 'health:ok'] } }),
    ],
    [
      'a symbol set on a note',
      note({ facets: { 'visual.symbol/v0': { kind: 'emoji', char: '\u{1F4CC}' } } }),
    ],
    [
      'an unregistered facet passes through',
      note({ facets: { 'other.thing/v1': { b: 1, a: [true, null], 2: 'x' } } }),
    ],
    ['a facet merged beside the others', note({ facets: { 'other.second/v0': 'plain' } })],
    ['a facet deleted by null', note({ facets: { 'other.thing/v1': null } })],
    ['a facet deleted that is not there', note({ facets: { 'other.absent/v0': null } })],
    ['facets and tags together', note({ tags: { add: ['both'] }, facets: { 'other.both/v0': 1 } })],
    ['a target document named', note({ target: 'document', tags: { add: ['aimed'] } })],
    [
      'two notes at once',
      { workspaceId: W, documentIds: [ids.note, ids.second], tags: { add: ['batch'] } },
    ],
    [
      'a note twice',
      { workspaceId: W, documentIds: [ids.second, ids.second], tags: { add: ['twice'] } },
    ],
    ['by segment', { workspaceId: SEGMENT, documentIds: [ids.second], tags: { add: ['segment'] } }],
  ]
}

function boardCalls(ids: Ids): Asked[] {
  const board = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.board], ...more })
  const node = (nodeId: string, more: Message) => board({ nodeId, ...more })
  const edge = (edgeId: string, more: Message) => board({ edgeId, ...more })
  return [
    ['a tag on the board', board({ tags: { add: ['board:one'] } })],
    ['a tag on the board by target', board({ target: 'canvas', tags: { add: ['board:two'] } })],
    ['a tag removed from the board', board({ tags: { remove: ['board:one'] } })],
    [
      'a theme on the canvas',
      board({ target: 'canvas', facets: { 'visual.theme/v0': { theme: 'visual.neon' } } }),
    ],
    [
      'a canvas theme with a tag',
      board({
        target: 'canvas',
        tags: { add: ['themed'] },
        facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
      }),
    ],
    [
      'the last canvas facets deleted',
      board({ target: 'canvas', facets: { 'visual.theme/v0': null, 'visual.edges/v0': null } }),
    ],
    ['a tag on a node', node('pad', { tags: { add: ['north'] } })],
    ['a tag removed from a node', node('pad', { tags: { remove: ['plain', 'north'] } })],
    ['a facet on a node', node('tower', { facets: { 'visual.shape/v0': { kind: 'hexagon' } } })],
    [
      'a facet and a tag on a node',
      node('tower', {
        tags: { add: ['both'] },
        facets: { 'visual.shape/v0': { kind: 'cylinder' } },
      }),
    ],
    ['a facet deleted from a node', node('tower', { facets: { 'visual.shape/v0': null } })],
    ['a tag on an edge', edge('fuels', { tags: { add: ['pipe'] } })],
    [
      'a facet on an edge',
      edge('fuels', { facets: { 'visual.edges/v0': { routing: 'orthogonal' } } }),
    ],
    ['a facet deleted from an edge', edge('fuels', { facets: { 'visual.edges/v0': null } })],
    ['a rename through the board', board({ tags: { rename: [{ from: 'plain', to: 'common' }] } })],
    [
      'a rename on one node',
      node('tower', { tags: { rename: [{ from: 'health:failing', to: 'health:down' }] } }),
    ],
    [
      'a rename that reaches nothing',
      board({ tags: { rename: [{ from: 'nothing', to: 'something' }] } }),
    ],
    [
      'a board with no elements',
      { workspaceId: W, documentIds: [ids.empty], tags: { add: ['bare'] } },
    ],
    [
      'a facet on a board by target and a tag together',
      {
        workspaceId: W,
        documentIds: [ids.empty],
        target: 'canvas',
        tags: { add: ['both'] },
        facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
      },
    ],
  ]
}

function refusedCalls(ids: Ids): Asked[] {
  const board = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.board], ...more })
  const note = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.note], ...more })
  return [
    ['neither tags nor facets', { workspaceId: W, documentIds: [ids.note] }],
    ['a node and an edge', board({ nodeId: 'pad', edgeId: 'fuels', tags: { add: ['x'] } })],
    [
      'a node of two documents',
      { workspaceId: W, documentIds: [ids.board, ids.empty], nodeId: 'pad', tags: { add: ['x'] } },
    ],
    [
      'an edge of two documents',
      {
        workspaceId: W,
        documentIds: [ids.board, ids.empty],
        edgeId: 'fuels',
        tags: { add: ['x'] },
      },
    ],
    ['a node and the canvas', board({ nodeId: 'pad', target: 'canvas', tags: { add: ['x'] } })],
    ['an edge and the canvas', board({ edgeId: 'fuels', target: 'canvas', tags: { add: ['x'] } })],
    [
      'facets on a board without a target',
      board({ facets: { 'visual.theme/v0': { theme: 'visual.neon' } } }),
    ],
    ['the canvas of a note', note({ target: 'canvas', tags: { add: ['x'] } })],
    [
      'the canvas of a note, facets',
      note({ target: 'canvas', facets: { 'visual.theme/v0': { theme: 'visual.neon' } } }),
    ],
    ['a node of a note', note({ nodeId: 'pad', tags: { add: ['x'] } })],
    ['an edge of a note', note({ edgeId: 'fuels', tags: { add: ['x'] } })],
    ['a node the board lacks', board({ nodeId: 'ghost', tags: { add: ['x'] } })],
    ['an edge the board lacks', board({ edgeId: 'ghost', tags: { add: ['x'] } })],
    [
      'a node of an empty board',
      { workspaceId: W, documentIds: [ids.empty], nodeId: 'pad', tags: { add: ['x'] } },
    ],
    ['a locked node', board({ nodeId: 'vault', tags: { add: ['x'] } })],
    [
      'a locked node, facets',
      board({ nodeId: 'vault', facets: { 'visual.shape/v0': { kind: 'hexagon' } } }),
    ],
    ['a locked edge', board({ edgeId: 'sealed', tags: { add: ['x'] } })],
    [
      'a rename reaching a locked node',
      board({ tags: { rename: [{ from: 'plain', to: 'common' }] } }),
    ],
    [
      'a rename not reaching the locked ones',
      board({ tags: { rename: [{ from: 'north', to: 'south' }] } }),
    ],
    [
      'a document the workspace lacks',
      { workspaceId: W, documentIds: [ids.note, NOTHING], tags: { add: ['x'] } },
    ],
    [
      'a workspace nothing answers to',
      { workspaceId: 'nope', documentIds: [ids.note], tags: { add: ['x'] } },
    ],
    [
      'another namespace',
      { workspaceId: `you/${SEGMENT}`, documentIds: [ids.note], tags: { add: ['x'] } },
    ],
    [
      'a kind mismatch later in the batch',
      { workspaceId: W, documentIds: [ids.note, ids.board], facets: { 'other.x/v0': 1 } },
    ],
    [
      'a canvas on a note later in the batch',
      {
        workspaceId: W,
        documentIds: [ids.board, ids.note],
        target: 'canvas',
        tags: { add: ['x'] },
      },
    ],
    [
      'a payload the facet refuses',
      note({ facets: { 'visual.symbol/v0': { kind: 'emoji', char: '✅\u{1F525}' } } }),
    ],
    [
      'a facet under an old version',
      note({ facets: { 'visual.symbol/v9': { kind: 'emoji', char: 'a' } } }),
    ],
    ['a facet the target excludes', note({ facets: { 'visual.shape/v0': { kind: 'hexagon' } } })],
    [
      'a facet on the canvas the target excludes',
      board({ target: 'canvas', facets: { 'visual.symbol/v0': { kind: 'emoji', char: 'a' } } }),
    ],
    [
      'a theme nothing registered',
      board({ target: 'canvas', facets: { 'visual.theme/v0': { theme: 'visual.chalk' } } }),
    ],
    [
      'a payload with a key the schema drops',
      board({ nodeId: 'tower', facets: { 'visual.shape/v0': { kind: 'hexagon', extra: 1 } } }),
    ],
    [
      'the first of two refused facets',
      board({
        nodeId: 'tower',
        facets: { 'visual.shape/v0': { kind: 'nope' }, 'visual.text/v0': 1 },
      }),
    ],
    ['a retired board', { workspaceId: W, documentIds: [ids.elderly], tags: { add: ['x'] } }],
    [
      'a retired board, a node',
      { workspaceId: W, documentIds: [ids.elderly], nodeId: 'e1', tags: { add: ['x'] } },
    ],
  ]
}

function limitCalls(ids: Ids): Asked[] {
  const crowded = (more: Message): Message => ({
    workspaceId: W,
    documentIds: [ids.crowded],
    ...more,
  })
  return [
    ['1024 tags on a note', crowded({ tags: { add: manyTags(1024) } })],
    ['one more than a note may carry', crowded({ tags: { add: ['over'] } })],
    ['a change that does not grow the set', crowded({ tags: { add: ['t1'], remove: ['t2'] } })],
    [
      'a rename that merges below the bound',
      crowded({ tags: { rename: [{ from: 't3', to: 't4' }] } }),
    ],
    ['an add of 1025 tags', crowded({ tags: { add: manyTags(1025, 'u') } })],
    ['a tag of 1025 characters', crowded({ tags: { add: ['a'.repeat(1025)] } })],
    [
      'a tag of 1024 characters',
      { workspaceId: W, documentIds: [ids.second], tags: { add: ['a'.repeat(1024)] } },
    ],
    [
      '50 documents',
      {
        workspaceId: W,
        documentIds: Array.from({ length: 50 }, () => ids.second),
        tags: { add: ['fifty'] },
      },
    ],
    [
      '51 documents',
      {
        workspaceId: W,
        documentIds: Array.from({ length: 51 }, () => ids.second),
        tags: { add: ['fifty'] },
      },
    ],
  ]
}

function fieldCalls(ids: Ids): Asked[] {
  const note = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.note], ...more })
  return [
    ['no arguments', undefined],
    ['empty arguments', {}],
    ['no documents', { workspaceId: W }],
    ['no documents at all', { workspaceId: W, documentIds: [], tags: { add: ['x'] } }],
    [
      'a lowercase document id',
      note({ documentIds: [ids.note?.toLowerCase()], tags: { add: ['x'] } }),
    ],
    ['a bad address', { workspaceId: 'a_b', documentIds: [ids.note], tags: { add: ['x'] } }],
    ['a string for the documents', { workspaceId: W, documentIds: ids.note, tags: { add: ['x'] } }],
    ['an empty node id', note({ nodeId: '', tags: { add: ['x'] } })],
    ['an empty edge id', note({ edgeId: '', tags: { add: ['x'] } })],
    ['an unknown target', note({ target: 'node', tags: { add: ['x'] } })],
    ['null for the target', note({ target: null, tags: { add: ['x'] } })],
    ['an empty tags object', note({ tags: {} })],
    ['tags naming nothing', note({ tags: { add: [], remove: [] } })],
    ['a string for the tags', note({ tags: 'x' })],
    ['a string for add', note({ tags: { add: 'x' } })],
    ['a number among the removals', note({ tags: { remove: ['x', 7] } })],
    ['an empty tag', note({ tags: { add: [''] } })],
    ['a colon that is not a scoped tag', note({ tags: { add: ['a:b:c'] } })],
    ['a scoped tag in capitals', note({ tags: { add: ['Health:ok'] } })],
    [
      'a rename entry with an unknown key',
      note({ tags: { rename: [{ from: 'a', to: 'b', extra: 1 }] } }),
    ],
    ['a rename entry missing a half', note({ tags: { rename: [{ from: 'a' }] } })],
    ['a rename to a colon tag', note({ tags: { rename: [{ from: 'a', to: 'x:y:z' }] } })],
    ['a rename from an empty name', note({ tags: { rename: [{ from: '', to: 'b' }] } })],
    ['an unknown key in tags', note({ tags: { add: ['x'], also: 1 } })],
    ['an array for the facets', note({ facets: [] })],
    ['a facet key off the pattern', note({ facets: { Bad: 1 } })],
    ['a core facet key', note({ facets: { tags: ['x'] } })],
    ['two facet keys off the pattern', note({ facets: { a: 1, B: 2 } })],
    ['a null for the facets', note({ facets: null })],
    ['an unknown key', note({ tags: { add: ['x'] }, follow: true })],
    [
      'every field wrong',
      { workspaceId: 1, documentIds: null, nodeId: 3, tags: 4, target: 5, facets: 6, extra: 7 },
    ],
  ]
}

/** The workspace's tag library and what it holds against a write. */
function libraryCalls(ids: Ids): Asked[] {
  const board = (more: Message): Message => ({ workspaceId: W, documentIds: [ids.board], ...more })
  return [
    [
      'a stencil written',
      board({ nodeId: 'pad', facets: { 'visual.stencil/v0': { stencil: 'visual.datastore' } } }),
    ],
    [
      'a stencil nothing registered',
      board({ nodeId: 'pad', facets: { 'visual.stencil/v0': { stencil: 'workspace.nothing' } } }),
    ],
    [
      'a tag value the library does not admit',
      board({ nodeId: 'pad', tags: { add: ['region:asia'] } }),
    ],
    [
      'a second value under an exclusive key',
      board({ nodeId: 'pad', tags: { add: ['health:failing'] } }),
    ],
    ['a value the library admits', board({ nodeId: 'pad', tags: { add: ['region:eu'] } })],
    [
      'a rename through the board against the library',
      board({ tags: { rename: [{ from: 'plain', to: 'region:asia' }] } }),
    ],
    [
      'a note against the library',
      { workspaceId: W, documentIds: [ids.second], tags: { add: ['region:asia'] } },
    ],
    [
      'a batch refused on its second document',
      { workspaceId: W, documentIds: [ids.second, ids.board], tags: { add: ['region:asia'] } },
    ],
    ['a plain tag against the library', board({ nodeId: 'pad', tags: { add: ['anything'] } })],
  ]
}

/** Builds the tag library document through the tool, as a caller would. */
const libraryDocument = (ids: Ids): Asked[] => [
  [
    'the library document written',
    {
      workspaceId: W,
      documentIds: [ids.tags],
      facets: {
        'visual.tags/v0': {
          keys: {
            health: { exclusive: true, values: { ok: {}, failing: {} } },
            region: { values: { eu: {}, us: {} } },
          },
        },
      },
    },
  ],
]

/** Reads back what the writes left, so a refused batch is seen to have kept nothing. */
const readBack = (ids: Ids, documentId: string | undefined, about: string): Asked[] => [
  [about, { workspaceId: W, documentIds: [documentId], tags: { add: ['readback'] } }],
]

function calls(ids: Ids): Asked[] {
  return [
    ...noteCalls(ids),
    ...boardCalls(ids),
    ...refusedCalls(ids),
    ...limitCalls(ids),
    ...fieldCalls(ids),
    ...libraryDocument(ids),
    ...libraryCalls(ids),
    ...readBack(ids, ids.second, 'the second note after a refused batch'),
  ]
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

/** `[peer, counter]` pairs, peers ascending numerically, then counters. */
function byPeer(pairs: [string, number][]): [string, number][] {
  return pairs.sort(([a, x], [b, y]) => (a === b ? x - y : BigInt(a) < BigInt(b) ? -1 : 1))
}

/** The stored record as a replica reads it back: its value, version vector and frontiers. */
async function stored(): Promise<Message> {
  const record = await workspaceRecordCopy(W)
  return {
    value: record.toJSON() as unknown,
    version: byPeer([...record.oplogVersion().toJSON()]),
    frontiers: byPeer(record.oplogFrontiers().map(({ peer, counter }) => [peer, counter])),
  }
}

/** Every record the daemon opens writes as `peer`; every other draw counts from the call's start. */
const drawn = { next: 0 }

function scriptRandomness(peer: number): void {
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: ArrayBufferView) => {
    if (array instanceof Uint32Array && array.length === 2) {
      array[0] = 0
      array[1] = peer
      return array
    }
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    for (let at = 0; at < bytes.length; at += 1) {
      bytes[at] = drawn.next % 256
      drawn.next += 1
    }
    return array
  }) as typeof globalThis.crypto.getRandomValues)
}

/** Every call over the record, answered by a daemon the record was loaded into. */
async function answer(record: Message): Promise<Message[]> {
  served.dir = 'data'
  scriptRandomness(Number(record.peer))
  const scripted = record.mint as { at: string }
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(scripted.at) })
  const heard: Heard = { activity: [], written: [] }
  const deps = await freshDeps(record.known as string[], heard)
  await importWorkspaceRecord(
    W,
    LoroDoc.fromSnapshot(base64ToBytes(record.snapshot as string) as Uint8Array),
  )
  const call = await caller(deps)
  const ids = record.ids as Ids
  let last = await stored()
  const rows: Message[] = [record, { case: 'before any call', record: last }]
  for (const [about, args] of calls(ids)) {
    heard.activity.length = 0
    heard.written.length = 0
    drawn.next = 0
    const name = 'wb_facet_set'
    const params = args === undefined ? { name } : { name, arguments: args }
    const answered = await call(name, args)
    const now = await stored()
    const moved = !isDeepStrictEqual(now, last)
    last = now
    rows.push({
      case: about,
      params,
      answer: answered,
      activity: [...heard.activity],
      written: [...heard.written],
      ...(moved ? { record: now } : {}),
    })
  }
  return rows
}

describe('wb_facet_set over a note and a board', () => {
  it('answers every recorded call as the recording holds it', { timeout: 180_000 }, async () => {
    const record = (await exists(FIXTURE)) ? (await rowsOf(FIXTURE))[0] : await buildRecord()
    if (record === undefined) throw new Error('the recording holds no record')
    const answered = await answer(record)
    if (RECORD || !(await exists(FIXTURE))) {
      await writeFile(FIXTURE, `${answered.map((row) => JSON.stringify(row)).join('\n')}\n`)
    }
    expect(await rowsOf(FIXTURE)).toEqual(answered)
  })
})
