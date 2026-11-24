import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_MANUAL_PER_DOCUMENT } from '@kamiazya/whiteboard-history'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

/**
 * `wb_version_save` as the daemon answers it: the recording the Rust ops
 * layer's `VersionSave` is replayed against
 * (`crates/adapters/mcp/tests/version_save.rs`).
 *
 * `oracle/version-save.jsonl` opens with one record row: a workspace record
 * (`snapshot`, kept as `W`), the registry rows that address it, the caller's
 * namespace, the handles a refusal may name, the ids of its documents by
 * name, `versions` (each document's history as the store lists it, newest
 * first: one save of `plan`, and `full` holding as many manual versions as a
 * document keeps), the keeper's `manualCeiling`, and `mint`: the ids the
 * keeper hands its saves, in the order it hands them, and the one instant
 * every save is stamped at. The mint is this file's, not the keeper's: the
 * version store's `nanoid(12)` and `Date` are replaced while the calls are
 * answered, so a rerun answers the same rows and the Rust fake is scripted
 * with the same mint rather than with anything an answer said.
 *
 * Every row after it is one `tools/call` and the result it drew, answered
 * over a fresh data directory the record and the rows were loaded into, in
 * order: a listing between saves shows what a refused batch did and did not
 * write. Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node version-save.oracle`.
 */
const FIXTURE = new URL('./oracle/version-save.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'
const NOTHING = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const MINT_AT = '2026-11-24T12:00:00.000Z'
const MINT_IDS = Array.from({ length: 24 }, (_, at) => `minted${String(at + 1).padStart(6, '0')}`)

const mint = vi.hoisted(() => ({ ids: null as string[] | null }))

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

const tmp = withTempDataDir('whiteboard-mcp-version-save-')

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

afterEach(() => {
  mint.ids = null
  vi.useRealTimers()
})

type Message = Record<string, unknown>

/** One saved version, as the record row keeps it. */
interface Kept {
  id: string
  createdAt: string
  auto: boolean
  label?: string
  operator?: { kind: 'ai' | 'human' | 'system'; displayName?: string }
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

async function freshDeps(known: string[]): Promise<ServerDeps> {
  const deps = await resolveTestServerDeps(join(tmp.dir, 'data'))
  await deps.documentIndex.createWorkspace({ workspaceId: W, segment: SEGMENT })
  return { ...deps, knownWorkspaceHandles: async () => known }
}

const DOCUMENTS: Message[] = [
  { op: 'document.create', path: 'plan', kind: 'markdown', markdown: 'first\n' },
  { op: 'document.create', path: 'board', kind: 'spatial' },
  { op: 'document.create', path: 'quiet', kind: 'markdown', markdown: 'never saved\n' },
  { op: 'document.create', path: 'full', kind: 'markdown', markdown: 'saved often\n' },
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

/**
 * `plan`'s one earlier save as the store kept it, and `full` holding as many
 * manual versions as one document keeps, oldest last.
 */
async function keptVersions(deps: ServerDeps, ids: Record<string, string>) {
  const earlier = await deps.versions.save(W, 'plan', { auto: false, label: 'earlier' })
  const plan: Kept = {
    id: earlier.id,
    createdAt: earlier.createdAt,
    auto: earlier.auto,
    ...(earlier.label === undefined ? {} : { label: earlier.label }),
    ...(earlier.operator === undefined ? {} : { operator: { kind: earlier.operator.kind } }),
  }
  const full: Kept[] = Array.from({ length: MAX_MANUAL_PER_DOCUMENT }, (_, at) => {
    const n = MAX_MANUAL_PER_DOCUMENT - at
    return {
      id: `full${String(n).padStart(4, '0')}`,
      createdAt: new Date(Date.parse('2026-11-01T00:00:00.000Z') + n * 1000).toISOString(),
      auto: false,
      label: `save ${n}`,
      operator: { kind: 'human', displayName: 'Ana' },
    }
  })
  return { [ids.plan ?? '']: [plan], [ids.full ?? '']: full }
}

async function buildRecord(): Promise<Message> {
  const known = [SEGMENT]
  const deps = await freshDeps(known)
  const call = await caller(deps)
  const ids = await createDocuments(call)
  const versions = await keptVersions(deps, ids)
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
    manualCeiling: MAX_MANUAL_PER_DOCUMENT,
    mint: { ids: MINT_IDS, at: MINT_AT },
  }
}

/**
 * Replaces the store's history with the kept rows, oldest first. A build ran
 * over the same data directory, and the store keeps a row it already holds,
 * so what the build saved is cleared first.
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

const EMOJI = '\u{1F600}'

type Asked = [string, string, Message | undefined]

const save = (about: string, args: Message | undefined): Asked => [about, 'wb_version_save', args]

const list = (about: string, documentId: string | undefined): Asked => [
  about,
  'wb_version_list',
  { workspaceId: W, documentId },
]

/** Saves that answer, and listings of what they and a refused batch left. */
function savingCalls(ids: Record<string, string>): Asked[] {
  return [
    save('one document', { workspaceId: W, documentIds: [ids.plan], label: 'checkpoint' }),
    save('by segment', { workspaceId: SEGMENT, documentIds: [ids.board], label: 'by segment' }),
    save('by namespace and segment', {
      workspaceId: `me/${SEGMENT}`,
      documentIds: [ids.plan],
      label: 'by handle',
    }),
    save('a batch, in the order asked', {
      workspaceId: W,
      documentIds: [ids.board, ids.plan, ids.quiet],
      label: 'together — é "q"',
    }),
    save('the same document twice', {
      workspaceId: W,
      documentIds: [ids.quiet, ids.quiet],
      label: 'twice',
    }),
    list('what the saves left', ids.plan),
    save('a batch naming a document nothing holds', {
      workspaceId: W,
      documentIds: [ids.board, NOTHING],
      label: 'never',
    }),
    list('nothing of the refused batch was kept', ids.board),
  ]
}

/** Saves the operation refuses, and one at the label's ceiling. */
function refusedCalls(ids: Record<string, string>): Asked[] {
  return [
    save('a document nothing holds, by segment', {
      workspaceId: SEGMENT,
      documentIds: [NOTHING],
      label: 'never',
    }),
    save('a workspace nothing answers to', {
      workspaceId: 'nope',
      documentIds: [ids.plan],
      label: 'never',
    }),
    save('an id nothing answers to', {
      workspaceId: NOTHING,
      documentIds: [ids.plan],
      label: 'never',
    }),
    save('another namespace', {
      workspaceId: `you/${SEGMENT}`,
      documentIds: [ids.plan],
      label: 'never',
    }),
    save('a document whose history is full', {
      workspaceId: W,
      documentIds: [ids.full],
      label: 'one more',
    }),
    save('a batch reaching a full history', {
      workspaceId: W,
      documentIds: [ids.quiet, ids.full],
      label: 'partly',
    }),
    list('what a batch stopped by a full history kept', ids.quiet),
    save('a label of 200 UTF-16 units', {
      workspaceId: W,
      documentIds: [ids.board],
      label: EMOJI.repeat(100),
    }),
  ]
}

/** Arguments the SDK refuses before the tool runs: what is absent or of the wrong shape. */
function missingCalls(ids: Record<string, string>): Asked[] {
  return [
    save('no arguments', undefined),
    save('empty arguments', {}),
    save('no documents', { workspaceId: W, label: 'x' }),
    save('no label', { workspaceId: W, documentIds: [ids.plan] }),
    save('no workspace', { documentIds: [ids.plan], label: 'x' }),
    save('an empty list', { workspaceId: W, documentIds: [], label: 'x' }),
    save('51 documents', {
      workspaceId: W,
      documentIds: Array.from({ length: 51 }, () => ids.plan),
      label: 'x',
    }),
    save('a string for the list', { workspaceId: W, documentIds: ids.plan, label: 'x' }),
    save('an empty string for the list', { workspaceId: W, documentIds: '', label: 'x' }),
  ]
}

/** Arguments the SDK refuses before the tool runs: values out of bounds or of the wrong type. */
function wrongValueCalls(ids: Record<string, string>): Asked[] {
  return [
    // Zod judges a string's length in code points, not in UTF-16 units.
    save('a string of 51 characters for the list', {
      workspaceId: W,
      documentIds: 'a'.repeat(51),
      label: 'x',
    }),
    save('a string of 30 characters and 60 units for the list', {
      workspaceId: W,
      documentIds: EMOJI.repeat(30),
      label: 'x',
    }),
    save('a number in the list', { workspaceId: W, documentIds: [ids.plan, 7], label: 'x' }),
    save('a lowercase id', {
      workspaceId: W,
      documentIds: [ids.plan?.toLowerCase()],
      label: 'x',
    }),
    save('an empty label', { workspaceId: W, documentIds: [ids.plan], label: '' }),
    save('a label of 201 units', {
      workspaceId: W,
      documentIds: [ids.plan],
      label: 'a'.repeat(201),
    }),
    save('a label of 101 characters and 202 units', {
      workspaceId: W,
      documentIds: [ids.plan],
      label: EMOJI.repeat(101),
    }),
    save('a number for the label', { workspaceId: W, documentIds: [ids.plan], label: 7 }),
    save('null for the label', { workspaceId: W, documentIds: [ids.plan], label: null }),
    save('a bad address', { workspaceId: 'a_b', documentIds: [ids.plan], label: 'x' }),
    save('an unknown key', {
      workspaceId: W,
      documentIds: [ids.plan],
      label: 'x',
      auto: true,
    }),
    save('every field wrong', { workspaceId: 1, documentIds: null, label: [], extra: true }),
  ]
}

/** The calls the recording answers, in order, by what each one is about. */
function calls(ids: Record<string, string>): Asked[] {
  return [...savingCalls(ids), ...refusedCalls(ids), ...missingCalls(ids), ...wrongValueCalls(ids)]
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
  const deps = await freshDeps(record.known as string[])
  await importWorkspaceRecord(
    W,
    LoroDoc.fromSnapshot(base64ToBytes(record.snapshot as string) as Uint8Array),
  )
  await adopt(deps, record.versions as Record<string, Kept[]>)
  const call = await caller(deps)
  const scripted = record.mint as { ids: string[]; at: string }
  mint.ids = [...scripted.ids]
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(scripted.at) })
  const rows: Message[] = [record]
  for (const [about, name, args] of calls(record.ids as Record<string, string>)) {
    const params = args === undefined ? { name } : { name, arguments: args }
    rows.push({ case: about, params, answer: await call(name, args) })
  }
  return rows
}

describe('wb_version_save over a document history', () => {
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
