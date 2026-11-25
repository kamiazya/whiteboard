import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc, LoroList, LoroMap, type LoroTree } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'
import { calls } from './thread-edit.oracle-calls.js'

/**
 * `wb_thread_edit` as the daemon answers it: the recording the Rust ops
 * layer's `ThreadEdit` is replayed against
 * (`crates/adapters/mcp/tests/thread_edit.rs`).
 *
 * `oracle/thread-edit.jsonl` opens with one record row: two workspace
 * records (`snapshot` kept as `W`, and `crowd`'s, kept as `C`, which holds
 * the documents at the thread and message ceilings so their size is carried
 * by the calls addressed to it alone), the registry rows that address them,
 * the caller's namespace, the handles a refusal may name, the ids of the
 * documents by name, and the scripting: `peer`, the replica every record the
 * daemon opens writes as, and `at`, the one instant every write is stamped
 * at (as text and as milliseconds). The record's peer is drawn from
 * `crypto.getRandomValues` and the stamps from `Date`, and both are replaced
 * while the calls are answered, so a rerun writes the same operations.
 *
 * Every row after it is one `tools/call`, the result it drew, what it told
 * the watching pages (`activity`), the documents it reported written, and
 * the stored record of the workspace it addressed after it (its value,
 * version vector and frontiers) when the call moved it. Re-record after a
 * deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node thread-edit.oracle`.
 */
const FIXTURE = new URL('./oracle/thread-edit.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const C = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
const SEGMENT = 'notes'
const CROWD = 'crowd'
const AT = '2026-11-24T12:00:00.000Z'
const PEER = 4_242_424_242
const MESSAGE_CEILING = 1000

type Message = Record<string, unknown>

const tmp = withTempDataDir('whiteboard-mcp-thread-edit-')

/**
 * Which data directory the daemon serves: the build writes the records in
 * one, and the calls are answered in another, so no record the build held in
 * a cache (writing as the build's own replica) answers them.
 */
const served = vi.hoisted(() => ({ dir: 'build' }))

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
  activity: Message[]
  written: Message[]
}

async function freshDeps(known: string[], heard?: Heard): Promise<ServerDeps> {
  const deps = await resolveTestServerDeps(dataDir())
  await deps.documentIndex.createWorkspace({ workspaceId: W, segment: SEGMENT })
  await deps.documentIndex.createWorkspace({ workspaceId: C, segment: CROWD })
  if (heard === undefined) return { ...deps, knownWorkspaceHandles: async () => known }
  const notifier = {
    agentActivity: (activity: unknown) => {
      heard.activity.push(activity as Message)
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

const idsOf = (created: Message): Record<string, string> =>
  Object.fromEntries(
    (created.results as { path: string; documentId: string }[]).map((r) => [r.path, r.documentId]),
  )

const textNode = (id: string, x: number, text: string): Message => ({
  op: 'node.add',
  node: { id, type: 'text', text, x, y: 0, width: 120, height: 60 },
})

const BOARD_OPS: Message[] = [
  textNode('a', 0, 'Alpha beta'),
  textNode('b', 300, 'Gamma'),
  textNode('c', 600, '\u{1F600} Delta \u{1F600}'),
  {
    op: 'node.add',
    node: { id: 'f', type: 'file', file: 'some/note', x: 900, y: 0, width: 120, height: 60 },
  },
  { op: 'edge.add', edge: { id: 'e1', from: { node: 'a' }, to: { node: 'b' } } },
  { op: 'edge.add', edge: { id: 'e2', from: { node: 'b' }, to: { node: 'a' } } },
]

const NOTES: Message[] = [
  {
    op: 'document.create',
    path: 'note',
    kind: 'markdown',
    markdown: 'why migration? a note about it',
  },
  { op: 'document.create', path: 'echo', kind: 'markdown', markdown: 'echo one, echo two' },
  {
    op: 'document.create',
    path: 'wide',
    kind: 'markdown',
    markdown: '\u{1F600} start \u{1F600} end',
  },
  { op: 'document.create', path: 'bare', kind: 'markdown', markdown: 'nothing said yet' },
  { op: 'document.create', path: 'gap', kind: 'markdown', markdown: 'a peer replied here' },
  { op: 'document.create', path: 'board', kind: 'spatial' },
  { op: 'document.create', path: 'quiet', kind: 'spatial' },
  { op: 'document.create', path: 'elderly', kind: 'spatial' },
  { op: 'document.create', path: 'archive', kind: 'markdown', markdown: 'a retired plane' },
  { op: 'document.create', path: 'fresh', kind: 'markdown', markdown: 'never commented on' },
  { op: 'document.create', path: 'freshboard', kind: 'spatial' },
]

const CROWDED: Message[] = [
  { op: 'document.create', path: 'open500', kind: 'markdown', markdown: 'many threads' },
  { op: 'document.create', path: 'deep', kind: 'markdown', markdown: 'a long thread' },
  { op: 'document.create', path: 'junk', kind: 'markdown', markdown: 'a thread with junk' },
]

/** The tree node meta map that hosts `documentId`. */
function hostOf(copy: LoroDoc, documentId: string): LoroMap {
  const tree = copy.getTree('tree') as LoroTree
  const node = tree.getNodes().find((each) => each.data.get('documentId') === documentId)
  if (node === undefined) throw new Error(`no node hosts ${documentId}`)
  return node.data
}

const addThreads = (count: number, from: number): Message[] =>
  Array.from({ length: count }, (_, at) => ({
    op: 'thread.add',
    threadId: `o${from + at}`,
    anchor: { kind: 'document' },
    body: 'x',
  }))

/** A thread of `messages` readable messages in the document, built through the tool. */
async function longThread(call: Call, documentId: string, threadId: string, messages: number) {
  await landed(call, 'wb_thread_edit', {
    workspaceId: C,
    documentId,
    ops: [{ op: 'thread.add', threadId, anchor: { kind: 'document' }, body: 'x' }],
  })
  for (let left = messages - 1; left > 0; left -= 200) {
    const batch = Array.from({ length: Math.min(200, left) }, () => ({
      op: 'message.add',
      threadId,
      body: 'x',
    }))
    await landed(call, 'wb_thread_edit', { workspaceId: C, documentId, ops: batch })
  }
}

/** The crowd workspace's documents at the ceilings, built through the tool. */
async function buildCrowd(call: Call): Promise<Record<string, string>> {
  const crowded = idsOf(
    await landed(call, 'wb_workspace_edit', {
      workspaceId: C,
      actor: 'claude-code/2.1',
      ops: CROWDED,
    }),
  )
  for (const [from, count] of [
    [1, 200],
    [201, 200],
    [401, 100],
  ] as const) {
    await landed(call, 'wb_thread_edit', {
      workspaceId: C,
      documentId: crowded.open500,
      ops: addThreads(count, from),
    })
  }
  await longThread(call, crowded.deep ?? '', 'd', MESSAGE_CEILING - 1)
  await longThread(call, crowded.junk ?? '', 'j', MESSAGE_CEILING - 1)
  return crowded
}

/**
 * What no tool writes: a gap a peer's merged reply leaves, a stored message
 * the schema refuses, a canvas in the retired elements list and comments in
 * the retired plane.
 */
async function storeStrangeShapes(
  call: Call,
  ids: Record<string, string>,
  crowded: Record<string, string>,
): Promise<void> {
  await landed(call, 'wb_thread_edit', {
    workspaceId: W,
    documentId: ids.gap,
    ops: [{ op: 'thread.add', threadId: 'th-1', anchor: { kind: 'document' }, body: 'first' }],
  })
  await editWorkspaceRecord(W, (copy) => {
    const threads = hostOf(copy, ids.gap ?? '').get('threads') as LoroMap
    const messages = (threads.get('th-1') as LoroMap).get('messages') as LoroMap
    messages.set('th-1-m3', {
      id: 'th-1-m3',
      body: 'from a peer',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const elements = hostOf(copy, ids.elderly ?? '').setContainer('elements', new LoroList())
    elements.push({ id: 'e1', type: 'rectangle' })
    const retired = hostOf(copy, ids.archive ?? '').setContainer('comments', new LoroMap())
    retired.set('c1', { id: 'c1', body: 'old' })
    // A document a thread was ever written to holds an empty `comments` map
    // beside its `threads`: the first write registers it with the roots it
    // reads, which no later write changes.
    for (const path of ['note', 'echo', 'wide', 'bare', 'board', 'quiet']) {
      hostOf(copy, ids[path] ?? '').setContainer('comments', new LoroMap())
    }
  })
  await editWorkspaceRecord(C, (copy) => {
    const threads = hostOf(copy, crowded.junk ?? '').get('threads') as LoroMap
    const messages = (threads.get('j') as LoroMap).get('messages') as LoroMap
    messages.set('j-junk', { body: 42 })
  })
}

async function buildRecord(): Promise<Message> {
  const known = [SEGMENT, CROWD]
  const deps = await freshDeps(known)
  const call = await caller(deps)
  const ids = idsOf(
    await landed(call, 'wb_workspace_edit', {
      workspaceId: W,
      actor: 'claude-code/2.1',
      ops: NOTES,
    }),
  )
  await landed(call, 'wb_canvas_edit', {
    workspaceId: W,
    documentId: ids.board,
    mode: 'apply',
    ops: BOARD_OPS,
  })
  const crowded = await buildCrowd(call)
  await storeStrangeShapes(call, ids, crowded)
  const registry = (await deps.documentIndex.listWorkspaces()).filter(
    (row) => row.workspaceId === W || row.workspaceId === C,
  )
  return {
    case: 'threads',
    snapshots: {
      [W]: bytesToBase64((await workspaceRecordCopy(W)).export({ mode: 'snapshot' })),
      [C]: bytesToBase64((await workspaceRecordCopy(C)).export({ mode: 'snapshot' })),
    },
    registry,
    callerNamespace: (await deps.callerNamespace?.()) ?? 'me',
    known,
    ids,
    crowded,
    peer: String(PEER),
    at: { text: AT, ms: Date.parse(AT) },
  }
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
async function stored(workspaceId: string): Promise<Message> {
  const record = await workspaceRecordCopy(workspaceId)
  return {
    value: record.toJSON() as unknown,
    version: byPeer([...record.oplogVersion().toJSON()]),
    frontiers: byPeer(record.oplogFrontiers().map(({ peer, counter }) => [peer, counter])),
  }
}

/**
 * Every record the daemon opens writes as `peer`: its replica id is the one
 * draw of two 32-bit words the engine makes. Every other draw is a count that
 * starts at the call's position in the recording, so no two calls draw alike.
 */
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

/** The workspace a call addresses: the crowd's by its handle or its id. */
const workspaceOf = (args: Message | undefined): string =>
  args?.workspaceId === CROWD || args?.workspaceId === C ? C : W

/** Every call over the records, answered by a daemon they were loaded into. */
async function answer(record: Message): Promise<Message[]> {
  served.dir = 'data'
  scriptRandomness(Number(record.peer))
  const scripted = record.at as { text: string }
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(scripted.text) })
  const heard: Heard = { activity: [], written: [] }
  const deps = await freshDeps(record.known as string[], heard)
  const snapshots = record.snapshots as Record<string, string>
  for (const workspaceId of [W, C]) {
    await importWorkspaceRecord(
      workspaceId,
      LoroDoc.fromSnapshot(base64ToBytes(snapshots[workspaceId] as string) as Uint8Array),
    )
  }
  const call = await caller(deps)
  const last: Record<string, Message> = { [W]: await stored(W), [C]: await stored(C) }
  const rows: Message[] = [
    record,
    { case: 'before any call', records: { [W]: last[W], [C]: last[C] } },
  ]
  for (const [position, [about, args]] of calls(record).entries()) {
    heard.activity.length = 0
    heard.written.length = 0
    drawn.next = position
    const params =
      args === undefined ? { name: 'wb_thread_edit' } : { name: 'wb_thread_edit', arguments: args }
    const answered = await call('wb_thread_edit', args)
    const workspaceId = workspaceOf(args)
    // The stored record is written only when the call moved it, so a row
    // without one left the record as the row before it did.
    const now = await stored(workspaceId)
    const moved = !isDeepStrictEqual(now, last[workspaceId])
    last[workspaceId] = now
    rows.push({
      case: about,
      params,
      answer: answered,
      activity: [...heard.activity],
      written: [...heard.written],
      ...(moved ? { record: now, in: workspaceId } : {}),
    })
  }
  return rows
}

describe('wb_thread_edit over documents with threads', () => {
  it('answers every recorded call as the recording holds it', { timeout: 300_000 }, async () => {
    const record = (await exists(FIXTURE)) ? (await rowsOf(FIXTURE))[0] : await buildRecord()
    if (record === undefined) throw new Error('the recording holds no record')
    const answered = await answer(record)
    if (RECORD || !(await exists(FIXTURE))) {
      await writeFile(FIXTURE, `${answered.map((row) => JSON.stringify(row)).join('\n')}\n`)
    }
    expect(await rowsOf(FIXTURE)).toEqual(answered)
  })
})
