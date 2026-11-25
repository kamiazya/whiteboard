import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'
import { calls } from './workspace-edit.oracle-calls.js'

/**
 * `wb_workspace_edit` as the daemon answers it: the recording the Rust ops
 * layer's `WorkspaceEdit` is replayed against
 * (`crates/adapters/mcp/tests/workspace_edit.rs`).
 *
 * `oracle/workspace-edit.jsonl` opens with one record row: the workspace
 * record (`snapshot`, kept as `W`), the registry row that addresses it, the
 * caller's namespace, the handles a refusal may name, the ids of the
 * documents by path, and the scripting: `peer`, the replica every record and
 * document the daemon opens writes as, and `at`, the one instant every write
 * is stamped at (as text and as milliseconds). The replica is drawn from
 * `crypto.getRandomValues` and the stamps from `Date`, and both are replaced
 * while the calls are answered; every other draw (a minted document id's
 * sixteen bytes) counts up from the call's position in the recording, so no
 * two calls mint alike and a rerun mints the same.
 *
 * Every row after it is one `tools/call`, the result it drew, what it told
 * the watching pages (`activity`), the documents it reported written, and the
 * stored record after it (its value, version vector and frontiers) when the
 * call moved it. Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node workspace-edit.oracle`.
 */
const FIXTURE = new URL('./oracle/workspace-edit.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'
const AT = '2026-11-24T12:00:00.000Z'
const PEER = 4_242_424_242

type Message = Record<string, unknown>

const tmp = withTempDataDir('whiteboard-mcp-workspace-edit-')

/**
 * Which data directory the daemon serves: the build writes the record in one,
 * and the calls are answered in another, so no record the build held in a
 * cache (writing as the build's own replica) answers them.
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
const { importWorkspaceRecord, workspaceRecordCopy } = await import(
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

const markdown = (path: string, body: string): Message => ({
  op: 'document.create',
  path,
  kind: 'markdown',
  markdown: body,
})

const spatial = (path: string, name?: string): Message => ({
  op: 'document.create',
  path,
  kind: 'spatial',
  ...(name === undefined ? {} : { name }),
})

/**
 * The workspace the calls run over: notes, boards and folders, one note
 * linking to `alpha` and `folder/child` (so moving either has references to
 * follow) and one linking to a path nothing holds.
 */
const NOTES: Message[] = [
  markdown('alpha', 'alpha body'),
  spatial('beta'),
  markdown('refs', 'see [[alpha]] and [[folder/child]]'),
  markdown('links', 'see [[nowhere/else]]'),
  markdown('folder/child', 'a child'),
  spatial('folder/sibling'),
  spatial('shelf/book'),
  spatial('named', 'Named Doc'),
  spatial('other', 'Other Doc'),
  spatial('deep'),
  spatial('deep/leaf'),
]

async function buildRecord(): Promise<Message> {
  const known = [SEGMENT]
  const deps = await freshDeps(known)
  const call = await caller(deps)
  const ids = idsOf(
    await landed(call, 'wb_workspace_edit', {
      workspaceId: W,
      actor: 'claude-code/2.1',
      ops: NOTES,
    }),
  )
  await landed(call, 'wb_workspace_edit', {
    workspaceId: W,
    ops: [{ op: 'folder.rename', path: 'shelf', name: 'Shelf' }],
  })
  const registry = (await deps.documentIndex.listWorkspaces()).filter(
    (row) => row.workspaceId === W,
  )
  return {
    case: 'workspace',
    snapshots: {
      [W]: bytesToBase64((await workspaceRecordCopy(W)).export({ mode: 'snapshot' })),
    },
    registry,
    callerNamespace: (await deps.callerNamespace?.()) ?? 'me',
    known,
    ids,
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
async function stored(): Promise<Message> {
  const record = await workspaceRecordCopy(W)
  return {
    value: record.toJSON() as unknown,
    version: byPeer([...record.oplogVersion().toJSON()]),
    frontiers: byPeer(record.oplogFrontiers().map(({ peer, counter }) => [peer, counter])),
  }
}

/**
 * Every record and document the daemon opens writes as `peer`: its replica id
 * is the one draw of two 32-bit words the engine makes. A minted id's sixteen
 * bytes are a count that starts at the call's position in the recording, so no
 * two calls mint alike; every other draw (the CRDT engine's own, which no
 * replay makes) counts on apart from it, so where an id lands does not depend
 * on how often the engine drew between two mints.
 */
const ID_BYTES = 16
const drawn = { next: 0, other: 0 }

function scriptRandomness(peer: number): void {
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: ArrayBufferView) => {
    if (array instanceof Uint32Array && array.length === 2) {
      array[0] = 0
      array[1] = peer
      return array
    }
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    const minting = bytes.length === ID_BYTES
    for (let at = 0; at < bytes.length; at += 1) {
      const count = minting ? drawn.next : drawn.other
      bytes[at] = count % 256
      if (minting) drawn.next += 1
      else drawn.other += 1
    }
    return array
  }) as typeof globalThis.crypto.getRandomValues)
}

/** Every call over the record, answered by a daemon it was loaded into. */
async function answer(record: Message): Promise<Message[]> {
  served.dir = 'data'
  scriptRandomness(Number(record.peer))
  const scripted = record.at as { text: string }
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(scripted.text) })
  const heard: Heard = { activity: [], written: [] }
  const deps = await freshDeps(record.known as string[], heard)
  const snapshots = record.snapshots as Record<string, string>
  await importWorkspaceRecord(
    W,
    LoroDoc.fromSnapshot(base64ToBytes(snapshots[W] as string) as Uint8Array),
  )
  const call = await caller(deps)
  let last = await stored()
  const rows: Message[] = [record, { case: 'before any call', record: last }]
  for (const [position, [about, args]] of calls(record).entries()) {
    heard.activity.length = 0
    heard.written.length = 0
    drawn.next = position
    const params =
      args === undefined
        ? { name: 'wb_workspace_edit' }
        : { name: 'wb_workspace_edit', arguments: args }
    const answered = await call('wb_workspace_edit', args)
    // The stored record is written only when the call moved it, so a row
    // without one left the record as the row before it did.
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

describe('wb_workspace_edit over a workspace of notes, boards and folders', () => {
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
