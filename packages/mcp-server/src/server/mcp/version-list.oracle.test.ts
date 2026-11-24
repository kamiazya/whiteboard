import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

/**
 * `wb_version_list` as the daemon answers it: the recording the Rust ops
 * layer's `VersionList` is replayed against
 * (`crates/adapters/mcp/tests/version_list.rs`).
 *
 * `oracle/version-list.jsonl` opens with one record row: a workspace record
 * (`snapshot`, kept as `W`), the registry rows that address it, the caller's
 * namespace, the handles a refusal may name, the ids of its documents by
 * name, and `versions`, each document's history as the version store lists
 * it (newest first). The history was built once, through `wb_version_save`
 * and through the store's own `save` for what no tool writes (an automatic
 * checkpoint, an operator of each kind, two saves in one millisecond, a
 * restore point), and is kept as the rows a promotion carries in, so a
 * rerun adopts exactly those rows. Delete the file to build it again: the
 * ids and stamps are minted, so a rebuild changes every row.
 *
 * Every row after it is one `tools/call` and the result it drew, answered
 * over a fresh data directory the record and the rows were loaded into.
 * Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node version-list.oracle`.
 */
const FIXTURE = new URL('./oracle/version-list.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'
const NOTHING = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

const tmp = withTempDataDir('whiteboard-mcp-version-list-')

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
const { getDb } = await import('../store/db/index.js')

type Message = Record<string, unknown>

/** One saved version, as the record row keeps it. */
interface Kept {
  id: string
  createdAt: string
  auto: boolean
  label?: string
  operator?: { kind: 'ai' | 'human' | 'system'; displayName?: string; agentId?: string }
  restoredFrom?: string
}

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

async function freshDeps(known: string[] | null): Promise<ServerDeps> {
  const deps = await resolveTestServerDeps(join(tmp.dir, 'data'))
  await deps.documentIndex.createWorkspace({ workspaceId: W, segment: SEGMENT })
  return known === null ? deps : { ...deps, knownWorkspaceHandles: async () => known }
}

/** The structured answer of a call that must succeed. */
async function ok(call: Call, name: string, args: Message): Promise<Message> {
  const answer = await call(name, args)
  if (answer.isError === true || answer.error !== undefined) {
    throw new Error(`${name} failed while building the record: ${JSON.stringify(answer)}`)
  }
  return answer.structuredContent as Message
}

const DOCUMENTS: Message[] = [
  { op: 'document.create', path: 'plan', kind: 'markdown', markdown: 'first\n' },
  { op: 'document.create', path: 'quiet', kind: 'markdown', markdown: 'never saved\n' },
  { op: 'document.create', path: 'board', kind: 'spatial' },
]

/** Creates every document through the tool, answering their ids by path. */
async function createDocuments(call: Call): Promise<Record<string, string>> {
  const created = await ok(call, 'wb_workspace_edit', {
    workspaceId: W,
    actor: 'claude-code/2.1',
    ops: DOCUMENTS,
  })
  const ids: Record<string, string> = {}
  for (const result of created.results as { path: string; documentId: string }[]) {
    ids[result.path] = result.documentId
  }
  return ids
}

/**
 * A history of every shape a row takes: a save through the tool, an
 * automatic checkpoint with no operator, an operator of each kind with and
 * without a display name (and with the ids an agent is not answered), two
 * saves in one millisecond, and a point a restore produced.
 */
async function saveVersions(deps: ServerDeps, call: Call, ids: Record<string, string>) {
  const saved = await ok(call, 'wb_version_save', {
    workspaceId: W,
    documentIds: [ids.plan],
    label: 'drafted "here" — é',
  })
  const first = (saved.saved as { version: { id: string } }[])[0]?.version.id
  if (first === undefined) throw new Error('the save answered no version')
  await deps.versions.save(W, 'plan', { auto: true })
  await deps.versions.save(W, 'plan', {
    auto: false,
    label: 'by a person',
    operator: { kind: 'human', displayName: 'Ana' },
  })
  await deps.versions.save(W, 'plan', {
    auto: false,
    operator: { kind: 'ai', displayName: 'Claude', agentId: 'a-1', workspaceId: W },
  })
  await deps.versions.save(W, 'plan', { auto: true, operator: { kind: 'system' } })
  await deps.versions.save(W, 'plan', { auto: false, label: 'restored', restoredFrom: first })
  await deps.versions.save(W, 'board', { auto: false, label: 'as drafted' })
  await deps.versions.save(W, 'board', { auto: false, label: 'after the meeting' })
}

/** A history as kept: the rows a promotion carries, oldest first. */
async function keptVersions(deps: ServerDeps, ids: Record<string, string>) {
  const versions: Record<string, Kept[]> = {}
  for (const [path, documentId] of Object.entries(ids)) {
    const listed = await deps.versions.list(W, path)
    versions[documentId] = listed.map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      auto: entry.auto,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      ...(entry.operator === undefined
        ? {}
        : {
            operator: {
              kind: entry.operator.kind,
              ...(entry.operator.displayName === undefined
                ? {}
                : { displayName: entry.operator.displayName }),
              ...(entry.operator.agentId === undefined ? {} : { agentId: entry.operator.agentId }),
            },
          }),
      ...(entry.restoredFrom === undefined ? {} : { restoredFrom: entry.restoredFrom }),
    }))
  }
  return versions
}

/** Two saves stamped in one millisecond: the later save is listed first. */
function sameMillisecond(versions: Record<string, Kept[]>, documentId: string): void {
  const held = versions[documentId] ?? []
  const [newest, next] = held
  if (newest === undefined || next === undefined) throw new Error('two versions to tie')
  held[0] = { ...newest, createdAt: next.createdAt }
}

/**
 * An automatic checkpoint with no operator, as a row saved before the
 * keeper stamped one reads: the store stamps every save it makes now.
 */
function unstamped(versions: Record<string, Kept[]>, documentId: string): void {
  const held = versions[documentId] ?? []
  const at = held.findLastIndex((row) => row.auto)
  const row = held[at]
  if (row === undefined) throw new Error('an automatic checkpoint to unstamp')
  const { operator: _stamped, ...rest } = row
  held[at] = rest
}

async function buildRecord(): Promise<Message> {
  const known = [SEGMENT]
  const deps = await freshDeps(known)
  const call = await caller(deps)
  const ids = await createDocuments(call)
  await saveVersions(deps, call, ids)
  const versions = await keptVersions(deps, ids)
  sameMillisecond(versions, ids.board ?? '')
  unstamped(versions, ids.plan ?? '')
  const record = await workspaceRecordCopy(W)
  const registry = (await deps.documentIndex.listWorkspaces()).filter(
    (row) => row.workspaceId === W,
  )
  return {
    case: 'history',
    snapshot: bytesToBase64(record.export({ mode: 'snapshot' })),
    registry,
    callerNamespace: (await deps.callerNamespace?.()) ?? 'me',
    known,
    ids,
    versions,
  }
}

/**
 * Replaces the store's history with the kept rows, oldest first, so a tie
 * lists as it was. A build ran over the same data directory, and the store
 * keeps a row it already holds, so what the build saved is cleared first.
 */
async function adopt(deps: ServerDeps, versions: Record<string, Kept[]>): Promise<void> {
  const db = await getDb(join(tmp.dir, 'data'))
  await db.deleteFrom('versions').execute()
  const rows = Object.entries(versions).flatMap(([documentId, kept]) =>
    [...kept].reverse().map((row) => ({
      ...row,
      documentId,
      createdAt: Date.parse(row.createdAt),
      frontiers: new Uint8Array(),
      elementCount: 0,
      contentDigest: '',
    })),
  )
  await deps.versions.adopt(W, rows)
}

/** The lists the recording answers, by what each one is about. */
function listCalls(ids: Record<string, string>): [string, Message | undefined][] {
  return [
    ['every shape of row', { workspaceId: W, documentId: ids.plan }],
    ['by segment', { workspaceId: SEGMENT, documentId: ids.plan }],
    ['by namespace and segment', { workspaceId: `me/${SEGMENT}`, documentId: ids.board }],
    ['a document never saved', { workspaceId: W, documentId: ids.quiet }],
    ['two saves in one millisecond', { workspaceId: W, documentId: ids.board }],
    ['a document nothing holds', { workspaceId: W, documentId: NOTHING }],
    ['a document nothing holds, by segment', { workspaceId: SEGMENT, documentId: NOTHING }],
    ['a workspace nothing answers to', { workspaceId: 'nope', documentId: ids.plan }],
    ['an id nothing answers to', { workspaceId: NOTHING, documentId: ids.plan }],
    ['another namespace', { workspaceId: `you/${SEGMENT}`, documentId: ids.plan }],
  ]
}

/** Arguments the SDK refuses before the tool runs. */
function validationCalls(ids: Record<string, string>): [string, Message | undefined][] {
  return [
    ['no arguments', undefined],
    ['empty arguments', {}],
    ['no document', { workspaceId: W }],
    ['no workspace', { documentId: ids.plan }],
    ['a lowercase id', { workspaceId: W, documentId: ids.plan?.toLowerCase() }],
    [
      'an id past the first character range',
      { workspaceId: W, documentId: `8${NOTHING.slice(1)}` },
    ],
    ['a number for the id', { workspaceId: W, documentId: 7 }],
    ['a bad address', { workspaceId: 'a_b', documentId: ids.plan }],
    ['three parts', { workspaceId: 'a/b/c', documentId: ids.plan }],
    ['an unknown key', { workspaceId: W, documentId: ids.plan, label: 'x' }],
    ['every field wrong', { workspaceId: 1, documentId: null, extra: true }],
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

/** Every call over the record, answered by a daemon the record and its history were loaded into. */
async function answer(record: Message): Promise<Message[]> {
  const deps = await freshDeps(record.known as string[] | null)
  await importWorkspaceRecord(
    W,
    LoroDoc.fromSnapshot(base64ToBytes(record.snapshot as string) as Uint8Array),
  )
  await adopt(deps, record.versions as Record<string, Kept[]>)
  const call = await caller(deps)
  const rows: Message[] = [record]
  const ids = record.ids as Record<string, string>
  for (const [about, args] of [...listCalls(ids), ...validationCalls(ids)]) {
    const params =
      args === undefined
        ? { name: 'wb_version_list' }
        : { name: 'wb_version_list', arguments: args }
    rows.push({ case: about, params, answer: await call('wb_version_list', args) })
  }
  return rows
}

describe('wb_version_list over a document history', () => {
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
