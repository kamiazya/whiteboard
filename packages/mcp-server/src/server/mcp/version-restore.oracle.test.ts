import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { RestoreProgressEvent, ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc, type LoroMap, type LoroText, type LoroTree } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

/**
 * `wb_version_restore` as the daemon answers it: the recording the Rust ops
 * layer's `VersionRestore` is replayed against
 * (`crates/adapters/mcp/tests/version_restore.rs`).
 *
 * `oracle/version-restore.jsonl` opens with one record row: a workspace
 * record (`snapshot`, kept as `W`) whose documents were edited after their
 * versions were saved, the registry rows that address it, the caller's
 * namespace, the handles a refusal may name, the ids of its documents by
 * name, `rows` (the version store's rows as the database holds them, which
 * this file loads back), `versions` (each document's history as the store
 * lists it, newest first), `checkouts` (each version's past document, as the
 * store's `load` answers it), and the scripting: `peer`, the replica every
 * record the daemon opens writes as, and `mint`, the ids the keeper hands
 * the restore points it saves and the one instant every write is stamped at
 * (as text and as milliseconds).
 * The record's peer is drawn from `crypto.getRandomValues`, the version id
 * from `nanoid(12)` and the stamps from `Date`, and all three are replaced
 * while the calls are answered, so a rerun writes the same operations.
 *
 * Every row after it is one `tools/call`, the result it drew, the restore
 * progress the call announced, the documents it reported written, and the
 * stored record after it (its value, version vector and frontiers), answered
 * in order over a fresh data directory the record and the rows were loaded
 * into. Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node version-restore.oracle`.
 */
const FIXTURE = new URL('./oracle/version-restore.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'
const NOTHING = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const MINT_AT = '2026-11-24T12:00:00.000Z'
const MINT_IDS = Array.from({ length: 24 }, (_, at) => `restore${String(at + 1).padStart(5, '0')}`)
const PEER = 4_242_424_242
const RESTORE_POINT_CEILING = 200

const mint = vi.hoisted(() => ({ ids: null as string[] | null }))

/**
 * Which data directory the daemon serves: the build writes the record in one,
 * and the calls are answered in another, so no record the build held in a
 * cache (writing as the build's own replica) answers them.
 */
const served = vi.hoisted(() => ({ dir: 'build' }))

vi.mock('nanoid', async (importOriginal) => {
  const real = await importOriginal<typeof import('nanoid')>()
  return {
    ...real,
    // A version id is the one `nanoid(12)` the save path mints; anything
    // else keeps the real alphabet.
    nanoid: (size?: number) => {
      const next = size === 12 ? mint.ids?.shift() : undefined
      return next ?? real.nanoid(size)
    },
  }
})

const tmp = withTempDataDir('whiteboard-mcp-version-restore-')

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
const { getDb } = await import('../store/db/index.js')

afterEach(() => {
  mint.ids = null
  served.dir = 'build'
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Message = Record<string, unknown>

/** One saved version, as the store lists it. */
interface Kept {
  id: string
  createdAt: string
  auto: boolean
  label?: string
  operator?: { kind: 'ai' | 'human' | 'system'; displayName?: string }
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

/** What a call told the watching pages and the write observer. */
interface Heard {
  progress: RestoreProgressEvent[]
  written: Message[]
}

async function freshDeps(known: string[], heard?: Heard): Promise<ServerDeps> {
  const deps = await resolveTestServerDeps(dataDir())
  await deps.documentIndex.createWorkspace({ workspaceId: W, segment: SEGMENT })
  if (heard === undefined) return { ...deps, knownWorkspaceHandles: async () => known }
  const notifier = {
    agentActivity: () => {},
    requestViewport: async () => false,
    versionCreated: () => {},
    restoreProgress: (event: RestoreProgressEvent) => {
      heard.progress.push(event)
    },
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

const DOCUMENTS: Message[] = [
  { op: 'document.create', path: 'plan', kind: 'markdown', markdown: 'first\n' },
  { op: 'document.create', path: 'same', kind: 'markdown', markdown: 'unchanged\n' },
  { op: 'document.create', path: 'board', kind: 'spatial' },
  { op: 'document.create', path: 'wide', kind: 'spatial' },
  { op: 'document.create', path: 'multi', kind: 'markdown', markdown: 'plain\n' },
  { op: 'document.create', path: 'untitled', kind: 'markdown', markdown: '# Old heading\n' },
  { op: 'document.create', path: 'other', kind: 'markdown', markdown: 'elsewhere\n' },
  { op: 'document.create', path: 'full', kind: 'markdown', markdown: 'kept often\n' },
  { op: 'document.create', path: 'bloated', kind: 'spatial' },
  { op: 'document.create', path: 'turncoat', kind: 'markdown', markdown: 'a note\n' },
  { op: 'document.create', path: 'folder/child', kind: 'markdown', markdown: 'below\n' },
]

/** Creates every document through the tool, answering their ids by path. */
async function createDocuments(call: Call): Promise<Record<string, string>> {
  const answer = await call('wb_workspace_edit', {
    workspaceId: W,
    actor: 'claude-code/2.1',
    ops: DOCUMENTS,
  })
  if (answer.isError === true || answer.error !== undefined) {
    throw new Error(`the documents were not created: ${JSON.stringify(answer)}`)
  }
  const created = answer.structuredContent as { results: { path: string; documentId: string }[] }
  return Object.fromEntries(created.results.map((result) => [result.path, result.documentId]))
}

/** One call during the build, which must land. */
async function landed(call: Call, name: string, args: Message): Promise<void> {
  const answer = await call(name, args)
  if (answer.isError === true || answer.error !== undefined) {
    throw new Error(`${name} did not land: ${JSON.stringify(answer)}`)
  }
}

const textNode = (id: string, x: number, text: string): Message => ({
  op: 'node.add',
  node: { id, type: 'text', text, x, y: 0, width: 120, height: 60 },
})

const draw = (documentId: string | undefined, ops: Message[]): Message => ({
  workspaceId: W,
  documentId,
  mode: 'apply',
  ops,
})

const setBody = (documentId: string | undefined, markdown: string): Message => ({
  workspaceId: W,
  actor: 'claude-code/2.1',
  ops: [
    {
      op: 'document.set',
      documentId,
      markdown: markdown.startsWith('---') ? markdown : `---\ntype: note\n---\n${markdown}`,
    },
  ],
})

/** The meta map of the tree node hosting `documentId`. */
function hostOf(doc: LoroDoc, documentId: string): LoroMap {
  const tree = doc.getTree('tree') as LoroTree
  const node = tree
    .getNodes({ withDeleted: false })
    .find((each) => each.data.get('documentId') === documentId)
  if (node === undefined) throw new Error(`no node hosts ${documentId}`)
  return node.data
}

/**
 * Rewrites a note's body in the record, as a page's editor does: a tool's
 * write also stamps who wrote it (the trust facets), so restoring over one
 * changes two of the document's roots, which the `multi` case keeps.
 */
async function rewrite(documentId: string | undefined, body: string): Promise<void> {
  await editWorkspaceRecord(W, (copy) => {
    const text = hostOf(copy, documentId ?? '').get('body') as LoroText
    text.delete(0, text.length)
    text.insert(0, body)
  })
}

/** Saves a manual version of the document at `path`, answering its id. */
async function saved(deps: ServerDeps, path: string, label: string): Promise<string> {
  return (await deps.versions.save(W, path, { auto: false, label })).id
}

/**
 * The documents' first states saved as versions, then each document moved on
 * from them: a body rewritten, a node added, nodes and an edge together, a
 * body and a facet together, a heading renamed. `bloated` and `turncoat` were
 * saved in states no sync write would keep (a node under the reserved key
 * `__proto__`, an envelope naming the other kind) and put right after.
 */
async function historyOf(
  deps: ServerDeps,
  call: Call,
  ids: Record<string, string>,
): Promise<Record<string, string>> {
  await landed(call, 'wb_canvas_edit', draw(ids.board, [textNode('a', 0, 'A')]))
  await landed(
    call,
    'wb_canvas_edit',
    draw(ids.wide, [textNode('a', 0, 'A'), textNode('b', 200, 'B')]),
  )
  await landed(call, 'wb_canvas_edit', draw(ids.bloated, [textNode('a', 0, 'A')]))
  const versionIds: Record<string, string> = {}
  for (const [path, label] of [
    ['plan', 'first draft'],
    ['same', 'as is'],
    ['board', 'one node'],
    ['wide', 'two nodes'],
    ['multi', 'plain'],
    ['untitled', 'old heading'],
    ['other', 'elsewhere'],
    ['full', 'kept'],
    ['folder/child', 'below'],
  ] as const) {
    versionIds[path] = await saved(deps, path, label)
  }
  await movedOn(call, ids)
  return { ...versionIds, ...(await savedPastBounds(deps, ids)) }
}

/** Each document moved on from its saved version. */
async function movedOn(call: Call, ids: Record<string, string>): Promise<void> {
  await rewrite(ids.plan, 'second\n')
  await landed(call, 'wb_canvas_edit', draw(ids.board, [textNode('b', 200, 'B')]))
  await landed(
    call,
    'wb_canvas_edit',
    draw(ids.wide, [
      textNode('c', 400, 'C'),
      { op: 'edge.add', edge: { id: 'ab', from: { node: 'a' }, to: { node: 'b' } } },
    ]),
  )
  await landed(
    call,
    'wb_workspace_edit',
    setBody(ids.multi, '---\ntype: note\ntags:\n  - draft\n---\nchanged\n'),
  )
  await rewrite(ids.untitled, '# New heading\n')
  await rewrite(ids.other, 'moved on\n')
  await rewrite(ids.full, 'moved on too\n')
}

/** `bloated` and `turncoat` saved in their states past a bound, then put right. */
async function savedPastBounds(deps: ServerDeps, ids: Record<string, string>) {
  const bloated = ids.bloated ?? ''
  await editWorkspaceRecord(W, (copy) => {
    const nodes = hostOf(copy, bloated).get('nodes') as LoroMap
    nodes.set('__proto__', { ...(nodes.get('a') as Message), id: '__proto__' })
  })
  const reserved = await saved(deps, 'bloated', 'reserved key')
  await editWorkspaceRecord(W, (copy) => {
    ;(hostOf(copy, bloated).get('nodes') as LoroMap).delete('__proto__')
  })
  const turncoat = ids.turncoat ?? ''
  const stating = (kind: string) =>
    editWorkspaceRecord(W, (copy) => {
      ;(hostOf(copy, turncoat).get('document') as LoroMap).set('kind', kind)
    })
  await stating('spatial')
  const otherKind = await saved(deps, 'turncoat', 'other kind')
  await stating('markdown')
  return { bloated: reserved, turncoat: otherKind }
}

type Row = Record<string, unknown>

/** The version rows as the database holds them, oldest first. */
async function versionRows(): Promise<Row[]> {
  const db = await getDb(dataDir())
  return (await db
    .selectFrom('versions')
    .selectAll()
    .where('workspaceId', '=', W)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute()) as Row[]
}

/**
 * Replaces the store's rows with the recorded ones, in the order recorded,
 * and gives `full` as many restore points as one document keeps, each a copy
 * of its saved version's row that names it.
 */
async function loadRows(rows: Row[], full: string, kept: string): Promise<void> {
  const template = rows.find((row) => row.id === kept)
  if (template === undefined) throw new Error('no version of full to copy')
  const points = Array.from({ length: RESTORE_POINT_CEILING }, (_, at) => ({
    ...template,
    id: `point${String(at + 1).padStart(4, '0')}`,
    documentId: full,
    auto: 1,
    label: null,
    restoredFrom: kept,
    createdAt: Date.parse('2026-11-01T00:00:00.000Z') + at * 1000,
  }))
  const db = await getDb(dataDir())
  await db.deleteFrom('versions').execute()
  for (const row of [...rows, ...points]) {
    await db
      .insertInto('versions')
      .values(row as never)
      .execute()
  }
}

/** Each document's history as the store lists it, by document id. */
async function listed(deps: ServerDeps, ids: Record<string, string>) {
  const versions: Record<string, Kept[]> = {}
  for (const [path, documentId] of Object.entries(ids)) {
    const entries = await deps.versions.list(W, path)
    if (entries.length === 0) continue
    versions[documentId] = entries.map((entry) => ({
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
            },
          }),
      ...(entry.restoredFrom === undefined ? {} : { restoredFrom: entry.restoredFrom }),
    }))
  }
  return versions
}

/** Every version's past document, as the store's `load` answers it. */
async function checkouts(deps: ServerDeps, rows: Row[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const id = row.id as string
    const bytes = await deps.versions.load(W, id)
    if (bytes !== null) out[id] = bytesToBase64(bytes)
  }
  return out
}

async function buildRecord(): Promise<Message> {
  const known = [SEGMENT]
  const deps = await freshDeps(known)
  const call = await caller(deps)
  const ids = await createDocuments(call)
  const versionIds = await historyOf(deps, call, ids)
  const rows = await versionRows()
  await loadRows(rows, ids.full ?? '', versionIds.full ?? '')
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
    versionIds,
    rows,
    versions: await listed(deps, ids),
    checkouts: await checkouts(deps, rows),
    restorePointCeiling: RESTORE_POINT_CEILING,
    peer: String(PEER),
    mint: { ids: MINT_IDS, at: MINT_AT, atMs: Date.parse(MINT_AT) },
  }
}

const EMOJI = '\u{1F600}'

type Asked = [string, string, Message | undefined]

const restore = (about: string, args: Message | undefined): Asked => [
  about,
  'wb_version_restore',
  args,
]

const list = (about: string, documentId: string | undefined): Asked => [
  about,
  'wb_version_list',
  { workspaceId: W, documentId },
]

type Ids = Record<string, string>

/** A restore of `documentId` to `versionId` in place, addressed by id. */
const back = (documentId: string | undefined, versionId: string | undefined) => ({
  workspaceId: W,
  documentId,
  versionId,
})

/** In-place restores the Rust core answers, and listings of what they recorded. */
function inPlaceCalls(ids: Ids, v: Ids): Asked[] {
  return [
    restore('a body back to its first draft', back(ids.plan, v.plan)),
    restore('the same restore again, nothing left to change', back(ids.plan, v.plan)),
    list('the restore point the first restore recorded', ids.plan),
    restore('a board back to one node', back(ids.board, v.board)),
    restore('a document already as saved', back(ids.same, v.same)),
    restore('a heading back, by segment', {
      workspaceId: SEGMENT,
      documentId: ids.untitled,
      versionId: v.untitled,
    }),
    restore('a document with a full set of restore points', back(ids.full, v.full)),
    restore('targetPath naming the document itself', {
      ...back(ids.other, v.other),
      targetPath: 'other',
      overwrite: false,
    }),
    list('a restore after the refused point takes the next id', ids.other),
    restore('subtree false is in place', { ...back(ids.plan, v.plan), subtree: false }),
    restore('a version of a child, by its folder', back(ids['folder/child'], v['folder/child'])),
  ]
}

/** Restores the Rust core does not answer yet: the other modes, and a write over two roots. */
function pendingCalls(ids: Ids, v: Ids): Asked[] {
  return [
    restore('nodes and an edge back at once', back(ids.wide, v.wide)),
    restore('a body and a facet back at once', back(ids.multi, v.multi)),
    restore('into a path nothing holds', { ...back(ids.plan, v.plan), targetPath: 'copies/plan' }),
    restore('onto a document of the same kind', {
      ...back(ids.other, v.other),
      targetPath: 'same',
      overwrite: true,
    }),
    restore('a subtree', { ...back(ids.plan, v.plan), subtree: true }),
    restore('a subtree naming its own path', {
      ...back(ids.plan, v.plan),
      targetPath: 'plan',
      subtree: true,
    }),
    restore('into a path of 1024 characters', {
      ...back(ids.plan, v.plan),
      targetPath: 'a'.repeat(1024),
    }),
  ]
}

/** Restores the operation refuses. */
function refusedCalls(ids: Ids, v: Ids): Asked[] {
  return [
    restore("another document's version", back(ids.plan, v.other)),
    restore('a version nothing saved', back(ids.plan, 'nosuchversion')),
    restore('a version id no keeper spells', back(ids.plan, '../plan')),
    restore('a version id past the keeper bound', back(ids.plan, 'v'.repeat(65))),
    restore('a document the workspace does not hold', back(NOTHING, v.plan)),
    restore('a workspace nothing answers to', {
      workspaceId: 'nope',
      documentId: ids.plan,
      versionId: v.plan,
    }),
    restore('a key no document may hold', back(ids.bloated, v.bloated)),
    restore('an envelope naming the other kind', back(ids.turncoat, v.turncoat)),
  ]
}

/** Restores into another path the operation refuses. */
function refusedTargetCalls(ids: Ids, v: Ids): Asked[] {
  return [
    restore('onto a document of the other kind', {
      ...back(ids.plan, v.plan),
      targetPath: 'board',
      overwrite: true,
    }),
    restore('onto a document without overwrite', {
      ...back(ids.plan, v.plan),
      targetPath: 'same',
    }),
    restore('onto a document, overwrite false', {
      ...back(ids.plan, v.plan),
      targetPath: 'same',
      overwrite: false,
    }),
    restore('a subtree into another path', {
      ...back(ids.plan, v.plan),
      targetPath: 'elsewhere',
      subtree: true,
    }),
    restore('a reserved key into a new path', {
      ...back(ids.bloated, v.bloated),
      targetPath: 'copies/bloated',
    }),
    restore('a reserved key onto a board', {
      ...back(ids.bloated, v.bloated),
      targetPath: 'wide',
      overwrite: true,
    }),
    restore('the other kind into a new path', {
      ...back(ids.turncoat, v.turncoat),
      targetPath: 'copies/turncoat',
    }),
    restore('the other kind onto a note', {
      ...back(ids.turncoat, v.turncoat),
      targetPath: 'same',
      overwrite: true,
    }),
    list('nothing a refusal reached was recorded', ids.bloated),
  ]
}

/** Arguments the SDK refuses before the tool runs. */
function invalidCalls(ids: Ids, v: Ids): Asked[] {
  const base = { workspaceId: W, documentId: ids.plan, versionId: v.plan }
  return [
    restore('no arguments', undefined),
    restore('empty arguments', {}),
    restore('no version', { workspaceId: W, documentId: ids.plan }),
    restore('no document', { workspaceId: W, versionId: v.plan }),
    restore('no workspace', { documentId: ids.plan, versionId: v.plan }),
    restore('an empty version id', { ...base, versionId: '' }),
    restore('a version id of 256 characters', { ...base, versionId: 'a'.repeat(256) }),
    restore('a version id of 257 characters', { ...base, versionId: 'a'.repeat(257) }),
    restore('a version id of 129 characters and 258 units', {
      ...base,
      versionId: EMOJI.repeat(129),
    }),
    restore('a version id of 128 characters and 256 units', {
      ...base,
      versionId: EMOJI.repeat(128),
    }),
    restore('an array for the version id', { ...base, versionId: ['a'] }),
    restore('an empty array for the version id', { ...base, versionId: [] }),
    restore('a number for the version id', { ...base, versionId: 7 }),
    restore('a lowercase document id', { ...base, documentId: ids.plan?.toLowerCase() }),
  ]
}

/** Arguments the SDK refuses for the mode's fields. */
function invalidModeCalls(ids: Ids, v: Ids): Asked[] {
  const base = { workspaceId: W, documentId: ids.plan, versionId: v.plan }
  return [
    restore('an empty target path', { ...base, targetPath: '' }),
    restore('a target path with an empty segment', { ...base, targetPath: 'a//b' }),
    restore('a target path ending in a slash', { ...base, targetPath: 'a/' }),
    restore('a target path with a space', { ...base, targetPath: 'a b' }),
    restore('a target path of 1025 characters', { ...base, targetPath: 'a'.repeat(1025) }),
    restore('a target path of 1025 characters with a space', {
      ...base,
      targetPath: `${'a'.repeat(1024)} `,
    }),
    restore('a target path of 600 characters and 1200 units', {
      ...base,
      targetPath: EMOJI.repeat(600),
    }),
    restore('a number for the target path', { ...base, targetPath: 7 }),
    restore('an array for the target path', { ...base, targetPath: [] }),
    restore('a string for overwrite', { ...base, overwrite: 'yes' }),
    restore('a number for subtree', { ...base, subtree: 1 }),
    restore('null for subtree', { ...base, subtree: null }),
    restore('an unknown key', { ...base, mode: 'in-place' }),
    restore('every field wrong', {
      workspaceId: 1,
      documentId: null,
      versionId: [],
      targetPath: false,
      overwrite: 0,
      subtree: 'no',
      extra: true,
    }),
  ]
}

/** The calls the recording answers, in order, by what each one is about. */
function calls(ids: Ids, versionIds: Ids): Asked[] {
  // The restores the Rust core leaves pending come last: each writes in the
  // daemon, and nothing after them reads what they wrote.
  return [
    ...inPlaceCalls(ids, versionIds),
    ...refusedCalls(ids, versionIds),
    ...refusedTargetCalls(ids, versionIds),
    ...invalidCalls(ids, versionIds),
    ...invalidModeCalls(ids, versionIds),
    ...pendingCalls(ids, versionIds),
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

/**
 * Every record the daemon opens writes as `peer`: its replica id is the one
 * draw of two 32-bit words the engine makes. Every other draw is a count from
 * the start of the call (`drawn.next` is reset before each), so a document a
 * pending restore creates is given the same id on every run.
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

/** Every call over the record, answered by a daemon the record and its history were loaded into. */
async function answer(record: Message): Promise<Message[]> {
  served.dir = 'data'
  scriptRandomness(Number(record.peer))
  const scripted = record.mint as { ids: string[]; at: string }
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(scripted.at) })
  const heard: Heard = { progress: [], written: [] }
  const deps = await freshDeps(record.known as string[], heard)
  await importWorkspaceRecord(
    W,
    LoroDoc.fromSnapshot(base64ToBytes(record.snapshot as string) as Uint8Array),
  )
  const ids = record.ids as Ids
  const versionIds = record.versionIds as Ids
  await loadRows(record.rows as Row[], ids.full ?? '', versionIds.full ?? '')
  const call = await caller(deps)
  mint.ids = [...scripted.ids]
  let last = await stored()
  const rows: Message[] = [record, { case: 'before any call', record: last }]
  for (const [about, name, args] of calls(ids, versionIds)) {
    heard.progress.length = 0
    heard.written.length = 0
    drawn.next = 0
    const params = args === undefined ? { name } : { name, arguments: args }
    const answered = await call(name, args)
    // The stored record is written only when the call moved it, so a row
    // without one left the record as the row before it did.
    const now = await stored()
    const moved = !isDeepStrictEqual(now, last)
    last = now
    rows.push({
      case: about,
      params,
      answer: answered,
      progress: [...heard.progress],
      written: [...heard.written],
      ...(moved ? { record: now } : {}),
    })
  }
  return rows
}

describe('wb_version_restore over a document history', () => {
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
