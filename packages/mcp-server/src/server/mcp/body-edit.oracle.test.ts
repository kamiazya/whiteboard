import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { AgentActivity, ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc, type LoroMap, type LoroTree } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'
import { calls, heldChanges, seedOps } from './body-edit.oracle-calls.js'

/**
 * `wb_body_edit` as the daemon answers it: the recording the Rust ops layer's
 * `BodyEdit` is replayed against (`crates/adapters/mcp/tests/body_edit.rs`).
 *
 * `oracle/body-edit.jsonl` opens with one record row: a workspace record
 * (`snapshot`, kept as `W`) holding the notes the calls edit, one proposal
 * whose changes carry verdicts, a board, the registry rows that address it,
 * the caller's namespace, the handles a refusal may name, the ids of its
 * documents by name, and the scripting: `peer`, the replica every record the
 * daemon opens writes as, and `mint`, the one instant every write is stamped
 * at (as text and as milliseconds). The record's peer is drawn from
 * `crypto.getRandomValues` and the stamps from `Date`, and both are replaced
 * while the calls are answered, so a rerun writes the same operations.
 *
 * Every row after the second is one `tools/call`, the result it drew, what it
 * announced to a watching page, the documents it reported written, and the
 * stored record after it when the call moved it (its value, version vector
 * and frontiers), answered in order over a fresh data directory the record
 * was loaded into. Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node body-edit.oracle`.
 */
const FIXTURE = new URL('./oracle/body-edit.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'
const MINT_AT = '2026-11-24T12:00:00.000Z'
const PEER = 4_242_424_242

const served = vi.hoisted(() => ({ dir: 'build' }))

const tmp = withTempDataDir('whiteboard-mcp-body-edit-')

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

async function populate(call: Call): Promise<Record<string, string>> {
  const created = await landed(call, 'wb_workspace_edit', {
    workspaceId: W,
    actor: 'claude-code/2.1',
    ops: seedOps(),
  })
  const ids: Record<string, string> = {}
  for (const result of created.results as { path: string; documentId: string }[]) {
    ids[result.path] = result.documentId
  }
  await landed(call, 'wb_body_edit', {
    workspaceId: W,
    documentId: ids.decided,
    proposalId: 'p1',
    ops: heldChanges(),
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

/** What no tool does: a person's verdict on two of the changes `decided` holds. */
function decide(copy: LoroDoc, documentId: string, verdicts: Record<string, string>): void {
  const plane = hostOf(copy, documentId).get('proposals') as LoroMap
  const changes = (plane.get('p1') as LoroMap).get('changes') as LoroMap
  for (const [id, status] of Object.entries(verdicts)) {
    changes.set(id, { ...(changes.get(id) as object), status })
  }
}

async function buildRecord(): Promise<Message> {
  const known = [SEGMENT]
  const deps = await freshDeps(known)
  const ids = await populate(await caller(deps))
  await editWorkspaceRecord(W, (copy) =>
    decide(copy, ids.decided ?? '', { old1: 'adopted', old2: 'dismissed' }),
  )
  const record = await workspaceRecordCopy(W)
  const registry = (await deps.documentIndex.listWorkspaces()).filter(
    (row) => row.workspaceId === W,
  )
  return {
    case: 'notes',
    snapshot: bytesToBase64(record.export({ mode: 'snapshot' })),
    registry,
    callerNamespace: (await deps.callerNamespace?.()) ?? 'me',
    known,
    ids,
    peer: String(PEER),
    mint: { at: MINT_AT, atMs: Date.parse(MINT_AT) },
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

/** What a recorded string may hold before it is told by its length; one note is a body's worth. */
const LONG_TEXT = 4096

/** A value with every long string cut to its start and its length, so a note at the limit is one line. */
function abridged(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > LONG_TEXT ? `${value.slice(0, 16)}...[${value.length}]` : value
  }
  if (Array.isArray(value)) return value.map(abridged)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, held]) => [key, abridged(held)]))
  }
  return value
}

/** The stored record as a replica reads it back: its value, version vector and frontiers. */
async function stored(): Promise<Message> {
  const record = await workspaceRecordCopy(W)
  return {
    value: abridged(record.toJSON()),
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
  const ids = record.ids as Record<string, string>
  let last = await stored()
  const rows: Message[] = [record, { case: 'before any call', record: last }]
  for (const [about, args] of calls(ids)) {
    heard.activity.length = 0
    heard.written.length = 0
    drawn.next = 0
    const name = 'wb_body_edit'
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

describe('wb_body_edit over notes', () => {
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
