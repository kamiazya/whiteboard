import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

/**
 * `wb_viewport_set` as the daemon answers it with a browser watching: the
 * recording the Rust ops layer's `ViewportSet` is replayed against
 * (`crates/adapters/mcp/tests/viewport_set.rs`).
 *
 * `oracle/viewport-set.jsonl` opens with one record row: a workspace record
 * (`snapshot`, kept as `W`), the registry rows that address it, the caller's
 * namespace, the handles a refusal may name, the ids of its documents by
 * path, and `watching`: the paths a page has open, each with whether it has
 * signalled `client_ready`. The calls are answered by the daemon's live
 * audience (`attachLiveAudience`) over those pages, registered as sync
 * streams, so `delivered` is what a page being there makes it.
 *
 * Every row after it is one `tools/call`, the result it drew and `told`: the
 * viewport requests a page was sent while it was answered, each as the
 * frame's JSON without the `requestId` the keeper mints. Re-record after a
 * deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node viewport-set.oracle`.
 */
const FIXTURE = new URL('./oracle/viewport-set.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'atlas'
const NOTHING = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

const tmp = withTempDataDir('whiteboard-mcp-viewport-set-')

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
const { attachLiveAudience } = await import('../canvas-client-notifier.js')
const { docKey, registerSyncStream, resetSyncStreamsForTests } = await import('../sync-streams.js')

afterEach(() => {
  resetSyncStreamsForTests()
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

async function freshDeps(known: string[]): Promise<ServerDeps> {
  const deps = await resolveTestServerDeps(join(tmp.dir, 'data'))
  await deps.documentIndex.createWorkspace({ workspaceId: W, segment: SEGMENT })
  return { ...deps, knownWorkspaceHandles: async () => known }
}

async function ok(call: Call, name: string, args: Message): Promise<Message> {
  const answer = await call(name, args)
  if (answer.isError === true || answer.error !== undefined) {
    throw new Error(`${name} failed while building the record: ${JSON.stringify(answer)}`)
  }
  return answer.structuredContent as Message
}

const BOARD_OPS: readonly Message[] = [
  { op: 'node.add', node: { id: 'pad', type: 'text', text: 'Launch pad', x: 0, y: 0 } },
  { op: 'node.add', node: { id: 'tower', type: 'text', text: 'Tower', x: 300, y: 0 } },
  {
    op: 'node.add',
    node: { id: 'crew', type: 'group', label: 'Crew', x: -400, y: 300, width: 300, height: 200 },
  },
  { op: 'edge.add', edge: { id: 'fuels', from: { node: 'pad' }, to: { node: 'tower' } } },
]

/** The documents, created through the tools, by path. */
async function populate(call: Call): Promise<Record<string, string>> {
  const created = await ok(call, 'wb_workspace_edit', {
    workspaceId: W,
    ops: [
      { op: 'document.create', path: 'board', kind: 'spatial' },
      { op: 'document.create', path: 'quiet', kind: 'spatial' },
      { op: 'document.create', path: 'opened', kind: 'spatial' },
      { op: 'document.create', path: 'note', kind: 'markdown', markdown: 'a note\n' },
    ],
  })
  const ids: Record<string, string> = {}
  for (const result of created.results as { path: string; documentId: string }[]) {
    ids[result.path] = result.documentId
  }
  await ok(call, 'wb_canvas_edit', {
    workspaceId: W,
    documentId: ids.board,
    mode: 'apply',
    ops: BOARD_OPS,
  })
  return ids
}

async function buildRecord(): Promise<Message> {
  const known = [SEGMENT]
  const deps = await freshDeps(known)
  const ids = await populate(await caller(deps))
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
    // `board` is open and ready; `opened` is open in a page that has not
    // signalled `client_ready`; `quiet` and `note` are open nowhere.
    watching: [
      { path: 'board', ready: true },
      { path: 'opened', ready: false },
    ],
  }
}

/** One page per path watched, each frame it is sent kept in `sent`. */
function openPages(watching: { path: string; ready: boolean }[], sent: string[]): void {
  for (const [at, page] of watching.entries()) {
    const key = docKey(W, page.path)
    registerSyncStream(`page-${at}`, {
      docs: new Map([[key, { ready: page.ready, key }]]),
      send: (frame) => {
        if (frame.event === 'message') sent.push(frame.data.raw)
      },
      userId: null,
      end: () => {},
    })
  }
}

/** The viewport requests among `raw`, each without its minted id. */
function told(raw: string[]): Message[] {
  return raw
    .map((text) => JSON.parse(text) as Message)
    .filter((frame) => frame.type === 'viewport_request')
    .map(({ requestId: _requestId, ...frame }) => frame)
}

type Asked = [string, Message | undefined]

/** Calls the tool answers: a page told, or nobody watching. */
function answeredCalls(ids: Record<string, string>): Asked[] {
  const at = (documentId: string | undefined, more: Message = {}): Message => ({
    workspaceId: W,
    documentId,
    ...more,
  })
  const board = (more: Message = {}) => at(ids.board, more)
  return [
    ['the whole board', board()],
    ['the whole board, fit named', board({ mode: 'fit' })],
    ['two nodes', board({ elementIds: ['pad', 'tower'] })],
    ['a group, fit named', board({ mode: 'fit', elementIds: ['crew'] })],
    ['a node twice', board({ elementIds: ['tower', 'tower'] })],
    ['no element ids', board({ elementIds: [] })],
    ['no element ids, fit named', board({ mode: 'fit', elementIds: [] })],
    ['a position', board({ scrollX: 120, scrollY: -40.5, zoom: 2 })],
    ['a position, move named', board({ mode: 'move', scrollX: 0, scrollY: 0, zoom: 1 })],
    ['move alone', board({ mode: 'move' })],
    ['a zoom alone', board({ zoom: 0.1 })],
    ['the largest zoom', board({ zoom: 10 })],
    ['a pan alone', board({ scrollY: 1e21 })],
    ['a tiny pan', board({ scrollX: -1.5e-7 })],
    ['by segment', { workspaceId: SEGMENT, documentId: ids.board }],
    ['by namespace and segment', { workspaceId: `me/${SEGMENT}`, documentId: ids.board }],
    ['a board open nowhere', at(ids.quiet)],
    ['a board open nowhere, a position', at(ids.quiet, { zoom: 3 })],
    ['a board open in a page not ready', at(ids.opened)],
  ]
}

/** Calls the operation refuses. */
function refusedCalls(ids: Record<string, string>): Asked[] {
  const board = (more: Message = {}) => ({ workspaceId: W, documentId: ids.board, ...more })
  return [
    ['a node the board lacks', board({ elementIds: ['ghost'] })],
    ['an edge id', board({ elementIds: ['fuels'] })],
    ['the first of several missing', board({ elementIds: ['pad', 'ghost', 'phantom'] })],
    ['a node of an empty board', { workspaceId: W, documentId: ids.quiet, elementIds: ['pad'] }],
    ['a markdown document', { workspaceId: W, documentId: ids.note }],
    ['a markdown document, a node', { workspaceId: W, documentId: ids.note, elementIds: ['x'] }],
    ['a document nothing holds', { workspaceId: W, documentId: NOTHING }],
    ['a document nothing holds, by segment', { workspaceId: SEGMENT, documentId: NOTHING }],
    ['a workspace nothing answers to', { workspaceId: 'nope', documentId: ids.board }],
    ['an id nothing answers to', { workspaceId: NOTHING, documentId: ids.board }],
    ['another namespace', { workspaceId: `you/${SEGMENT}`, documentId: ids.board }],
  ]
}

/** Arguments the SDK refuses before the tool runs, field by field. */
function fieldCalls(ids: Record<string, string>): Asked[] {
  const board = (more: Message) => ({ workspaceId: W, documentId: ids.board, ...more })
  return [
    ['no arguments', undefined],
    ['empty arguments', {}],
    ['no document', { workspaceId: W }],
    ['a lowercase document id', { workspaceId: W, documentId: ids.board?.toLowerCase() }],
    ['a number for the document', { workspaceId: W, documentId: 7 }],
    ['a bad address', { workspaceId: 'a_b', documentId: ids.board }],
    ['an unknown mode', board({ mode: 'zoom' })],
    ['null for the mode', board({ mode: null })],
    ['a string for the ids', board({ elementIds: 'pad' })],
    ['a long string for the ids', board({ elementIds: 'p'.repeat(2001) })],
    ['an empty id', board({ elementIds: ['pad', ''] })],
    ['a number among the ids', board({ elementIds: ['pad', 7] })],
    ['2001 ids', board({ elementIds: Array.from({ length: 2001 }, () => 'pad') })],
    ['2000 ids', board({ elementIds: Array.from({ length: 2000 }, () => 'pad') })],
    ['a string for scrollX', board({ scrollX: '1' })],
    ['null for scrollY', board({ scrollY: null })],
    ['a boolean for the zoom', board({ zoom: true })],
    ['a zoom too small', board({ zoom: 0.05 })],
    ['a zoom too large', board({ zoom: 10.5 })],
    ['a zero zoom', board({ zoom: 0 })],
    ['a negative zoom', board({ zoom: -2 })],
    ['an unknown key', board({ follow: true })],
    // Written in sorted order: a client's order is not one every reader of
    // the arguments keeps.
    ['two unknown keys', board({ zoom: 1, at: 'x', follow: true })],
    ['every field wrong', { workspaceId: 1, documentId: null, mode: 3, zoom: 'x', extra: 1 }],
  ]
}

/** Arguments the schema's refinement refuses, alone and beside other issues. */
function conflictCalls(ids: Record<string, string>): Asked[] {
  const board = (more: Message) => ({ workspaceId: W, documentId: ids.board, ...more })
  return [
    ['ids and a position', board({ elementIds: ['pad'], scrollX: 1 })],
    ['ids and a zoom', board({ elementIds: [], zoom: 1 })],
    ['fit and a position', board({ mode: 'fit', scrollY: 3 })],
    ['fit and a zoom', board({ mode: 'fit', zoom: 2 })],
    ['move and ids', board({ mode: 'move', elementIds: ['pad'] })],
    ['move and no ids', board({ mode: 'move', elementIds: [] })],
    ['move, ids and a position', board({ mode: 'move', elementIds: ['pad'], zoom: 1 })],
    ['fit, ids and a position', board({ mode: 'fit', elementIds: ['pad'], scrollX: 1 })],
    ['a conflict and a zoom out of range', board({ elementIds: ['pad'], zoom: 11 })],
    ['a conflict and an empty id', board({ elementIds: [''], scrollX: 1 })],
    ['a conflict and an unknown key', board({ elementIds: ['pad'], zoom: 1, extra: 1 })],
    ['a conflict and a bad document', { workspaceId: W, documentId: 'x', mode: 'fit', zoom: 1 }],
    [
      'a conflict and a bad address',
      { workspaceId: 'a_b', documentId: ids.board, scrollX: 1, elementIds: [] },
    ],
    ['a conflict and a missing document', { workspaceId: W, elementIds: ['pad'], zoom: 1 }],
    ['a conflict and an unknown mode', board({ mode: 'pan', elementIds: ['pad'], zoom: 1 })],
    ['a conflict and a string scrollX', board({ elementIds: ['pad'], scrollX: '1', zoom: 1 })],
    ['a conflict and a number id', board({ elementIds: [7], zoom: 1 })],
    [
      'a conflict and 2001 ids',
      board({ elementIds: Array.from({ length: 2001 }, () => 'a'), zoom: 1 }),
    ],
    ['a conflict and a string for the ids', board({ elementIds: 'pad', zoom: 1 })],
  ]
}

/** The calls the recording answers, in order, by what each one is about. */
function calls(ids: Record<string, string>): Asked[] {
  return [...answeredCalls(ids), ...refusedCalls(ids), ...fieldCalls(ids), ...conflictCalls(ids)]
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

/** Every call over the record, answered by a daemon with pages open on it. */
async function answer(record: Message): Promise<Message[]> {
  const deps = attachLiveAudience(await freshDeps(record.known as string[]))
  await importWorkspaceRecord(
    W,
    LoroDoc.fromSnapshot(base64ToBytes(record.snapshot as string) as Uint8Array),
  )
  const sent: string[] = []
  openPages(record.watching as { path: string; ready: boolean }[], sent)
  const call = await caller(deps)
  const rows: Message[] = [record]
  for (const [about, args] of calls(record.ids as Record<string, string>)) {
    const params =
      args === undefined
        ? { name: 'wb_viewport_set' }
        : { name: 'wb_viewport_set', arguments: args }
    sent.length = 0
    const answered = await call('wb_viewport_set', args)
    rows.push({ case: about, params, answer: answered, told: told(sent) })
  }
  return rows
}

describe('wb_viewport_set over a board a page watches', () => {
  it('answers every recorded call as the recording holds it', { timeout: 120_000 }, async () => {
    const record = (await exists(FIXTURE)) ? (await rowsOf(FIXTURE))[0] : await buildRecord()
    if (record === undefined) throw new Error('the recording holds no record')
    const answered = await answer(record)
    if (RECORD || !(await exists(FIXTURE))) {
      await writeFile(FIXTURE, `${answered.map((row) => JSON.stringify(row)).join('\n')}\n`)
    }
    expect(await rowsOf(FIXTURE)).toEqual(answered)
  })
})
