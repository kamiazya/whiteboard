import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { AgentActivity, ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc, LoroList, type LoroMap, type LoroTree } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'
import {
  BOARD_LOCKS,
  BOARD_OPS,
  BOARD_TAGS,
  calls,
  crowdedBatches,
  DOCUMENTS,
  WIDE_OPS,
} from './canvas-snapshot.oracle-calls.js'

/**
 * `wb_canvas_snapshot` as the daemon answers it: the recording the Rust ops
 * layer's `CanvasSnapshot` is replayed against
 * (`crates/adapters/mcp/tests/canvas_snapshot.rs`).
 *
 * `oracle/canvas-snapshot.jsonl` opens with one record row: a workspace
 * record (`snapshot`, kept as `W`) holding a note, a board with every kind of
 * node dressed and plain, locked and not, with edges and lines in every
 * shape, an empty board, a board one past each of the snapshot's caps, one
 * in a shape no tool writes any more and two whose facets hold several keys, the registry rows that address it, the
 * caller's namespace, the handles a refusal may name, the ids of its
 * documents by name, and the scripting: `peer`, the replica every record the
 * daemon opens writes as, and `mint`, the one instant a write would be
 * stamped at. The record's peer is drawn from `crypto.getRandomValues` and
 * the stamps from `Date`, and both are replaced while the calls are answered,
 * so a rerun is the same.
 *
 * Every row after the second is one `tools/call`, the result it drew, what it
 * announced to a watching page, the documents it reported written, and the
 * stored record after it when the call moved it, answered in order over a
 * fresh data directory the record was loaded into. The tool only reads, so
 * no row moves it. Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node canvas-snapshot.oracle`.
 */
const FIXTURE = new URL('./oracle/canvas-snapshot.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'
const MINT_AT = '2026-11-24T12:00:00.000Z'
const PEER = 4_242_424_242

const served = vi.hoisted(() => ({ dir: 'build' }))

const tmp = withTempDataDir('whiteboard-mcp-canvas-snapshot-')

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
    ops: DOCUMENTS,
  })
  const ids: Record<string, string> = {}
  for (const result of created.results as { path: string; documentId: string }[]) {
    ids[result.path] = result.documentId
  }
  const edit = (documentId: string | undefined, ops: Message[]) =>
    landed(call, 'wb_canvas_edit', { workspaceId: W, documentId, mode: 'apply', ops })
  await edit(ids.board, BOARD_OPS)
  for (const more of BOARD_TAGS) {
    await landed(call, 'wb_facet_set', { workspaceId: W, documentIds: [ids.board], ...more })
  }
  await edit(ids.board, BOARD_LOCKS)
  for (const batch of crowdedBatches()) await edit(ids.crowded, batch)
  for (const [path, ops] of Object.entries(WIDE_OPS)) await edit(ids[path], ops)
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
function retire(copy: LoroDoc, documentId: string): void {
  const elements = hostOf(copy, documentId).setContainer('elements', new LoroList())
  elements.push({ id: 'e1', type: 'rectangle' })
}

async function buildRecord(): Promise<Message> {
  const known = [SEGMENT]
  const deps = await freshDeps(known)
  const ids = await populate(await caller(deps))
  await editWorkspaceRecord(W, (copy) => retire(copy, ids.elderly ?? ''))
  const record = await workspaceRecordCopy(W)
  const registry = (await deps.documentIndex.listWorkspaces()).filter(
    (row) => row.workspaceId === W,
  )
  return {
    case: 'boards',
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
  const ids = record.ids as Record<string, string>
  let last = await stored()
  const rows: Message[] = [record, { case: 'before any call', record: last }]
  for (const [about, args] of calls(ids)) {
    heard.activity.length = 0
    heard.written.length = 0
    drawn.next = 0
    const name = 'wb_canvas_snapshot'
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

describe('wb_canvas_snapshot over boards and a note', () => {
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
