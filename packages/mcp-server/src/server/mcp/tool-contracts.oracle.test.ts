import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { base64ToBytes } from '@kamiazya/whiteboard-model'
import { matchesWorkspaceLookup, type WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { createServer, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import { wbDocumentResolve } from '@kamiazya/whiteboard-server-core/test-utils/tools'
import {
  LoroWorkspaceDocumentIndex,
  type WorkspaceRegistry,
} from '@kamiazya/whiteboard-workspace-index'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { repoRoot } from '../../shared/test-utils/repo-root.js'
import { withTempDataDir } from '../routes/_test-helpers.js'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'

/**
 * The published surface of every tool — what `tools/list` hands a model — is
 * a contract the Rust MCP adapter reads: `contracts/tools/<name>.json` holds
 * each listed tool exactly as the TypeScript server lists it. The Zod schemas
 * stay the source; the files are written FROM the live listing, so this test
 * is what keeps them equal to it.
 *
 * Two recordings of what the Rust ops layer implements are kept here too, and
 * both draw their inputs from the first, so this test reads nothing but the
 * recordings to answer them again:
 *
 * - `oracle/document-reads.jsonl`, server-core's
 *   operations as `createServer`'s tool record calls them (the address
 *   resolved first) and as the `/api/v1` resolve calls its operation. A
 *   record row is a workspace record (`snapshot`, `null` when the keeper
 *   holds none; always kept as `W`), the registry rows that address it, the
 *   caller's namespace and the handles a refusal may name (`known`, `null`
 *   for none); each call row after it names an operation and its input, and
 *   recording answers it (`expect`: the output, or the class thrown and its
 *   message). Replayed by `crates/ops/ops/tests/document_reads.rs`.
 * - `oracle/tool-calls.jsonl`, the answers to `tools/call` over the same
 *   records: the addresses each record's list rows name, and over the record
 *   with no workspace the SDK's own validation failures too. Replayed by
 *   `crates/adapters/mcp/tests/tool_calls.rs`.
 *
 * Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node tool-contracts.oracle`,
 * then `pnpm exec biome format --write contracts/tools` (the comparison is of
 * parsed JSON, so the formatter's wrapping is no difference). A new call is
 * added by writing its row, without `expect`, into the ops fixture.
 */
const CONTRACTS = join(repoRoot(), 'contracts', 'tools')
const CALLS = new URL('./oracle/tool-calls.jsonl', import.meta.url)
const READS = new URL('./oracle/document-reads.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'

const tmp = withTempDataDir('whiteboard-mcp-tool-contracts-')

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
  return (message) =>
    new Promise((resolve) => {
      waiting.set(message.id, resolve)
      void clientSide.send(message as never)
    })
}

async function listedTools(deps: ServerDeps): Promise<Message[]> {
  const send = await session(await createMcpServer(deps))
  const answer = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  return (answer.result as { tools: Message[] }).tools
}

const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

/** A recording's rows, inputs and answers alike. */
async function rowsOf(file: string | URL): Promise<Message[]> {
  return (await readFile(file, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Message)
}

const writeRows = (file: string | URL, rows: Message[]) =>
  writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)

/** A workspace record and how it is addressed, as a record row holds it. */
interface StoredRecord {
  case: string
  snapshot: string | null
  registry: WorkspaceEntry[]
  callerNamespace: string
  known: string[] | null
}

/** The record a row is, or undefined for a call. */
const recordOf = (row: Message) =>
  row.snapshot === undefined ? undefined : (row as unknown as StoredRecord)

/** The index over one record, kept as `W`, and the registry rows that address it. */
function indexOver(record: StoredRecord): LoroWorkspaceDocumentIndex {
  const bytes = record.snapshot === null ? null : base64ToBytes(record.snapshot)
  if (record.snapshot !== null && bytes === null)
    throw new Error(`a snapshot that is not base64: ${record.snapshot}`)
  const docs = {
    open: async (workspaceId: string) =>
      bytes === null || workspaceId !== W ? null : LoroDoc.fromSnapshot(bytes),
    create: () => Promise.reject(new Error('a read creates nothing')),
    save: () => Promise.reject(new Error('a read saves nothing')),
    readCursor: () => Promise.reject(new Error('not read')),
    catchUp: () => Promise.reject(new Error('not read')),
    storedVersion: () => Promise.reject(new Error('not read')),
  }
  const registry: WorkspaceRegistry = {
    listWorkspaces: async () => record.registry,
    findWorkspace: async (lookup) =>
      record.registry.find((row) => matchesWorkspaceLookup(row, lookup)) ?? null,
    renameWorkspace: () => Promise.reject(new Error('a read renames nothing')),
  }
  return new LoroWorkspaceDocumentIndex(docs, {} as never, registry)
}

/** The server's deps over one record: its index, its caller, and what that caller may see. */
async function depsOver(record: StoredRecord): Promise<ServerDeps> {
  const base = await resolveTestServerDeps(join(tmp.dir, 'data'))
  const known = record.known
  return {
    ...base,
    documentIndex: indexOver(record),
    knownWorkspaceHandles: known === null ? undefined : async () => known,
    callerNamespace: async () => record.callerNamespace,
  }
}

/** What `call` drew: its output, or the class it threw and its message. */
async function answerOf(call: () => Promise<unknown>): Promise<Message> {
  try {
    return { ok: await call() }
  } catch (err) {
    if (!(err instanceof Error)) throw err
    return { err: { class: err.name, message: err.message } }
  }
}

/** One call row of the ops fixture, answered over `deps`. */
function answerRead(deps: ServerDeps, call: Message): Promise<Message> {
  if (call.op === 'list') {
    const input = { workspaceId: call.workspaceId as string }
    return answerOf(() => createServer(deps).tools.documentList.execute(input))
  }
  const input = { workspaceId: W, documentId: call.documentId as string }
  return answerOf(() => wbDocumentResolve(deps, input))
}

/** Every row of the ops fixture, each call answered again. */
async function recordReads(): Promise<Message[]> {
  const rows: Message[] = []
  let deps: ServerDeps | undefined
  for (const row of await rowsOf(READS)) {
    const record = recordOf(row)
    if (record !== undefined) {
      deps = await depsOver(record)
      rows.push(row)
      continue
    }
    if (deps === undefined) throw new Error('a call before any record')
    const { expect: _held, ...call } = row
    rows.push({ ...call, expect: await answerRead(deps, call) })
  }
  return rows
}

/** Arguments the SDK refuses before the tool runs, and addresses nothing answers to. */
const LIST_ARGUMENTS: (Message | undefined)[] = [
  { workspaceId: W },
  undefined,
  {},
  { workspaceId: 1 },
  { workspaceId: null },
  { workspaceId: true },
  { workspaceId: [] },
  { workspaceId: {} },
  { workspaceId: '' },
  { workspaceId: 'a_b' },
  { workspaceId: 'a/b/c' },
  { workspaceId: '/a' },
  { workspaceId: 'a/' },
  { workspaceId: 'ü' },
  { workspaceId: 'a b' },
  { workspaceId: '-' },
  { workspaceId: 'a-b/C-9' },
  { workspaceId: 'a\nb' },
  { workspaceId: 'nope' },
  { workspaceId: 'me/nope' },
  { workspaceId: W, extra: 1 },
  { extra: 1 },
  { workspaceId: 2, b: 1, a: 2 },
  { workspaceId: 'a_b', extra: null },
  { workspaceId: W, 'a"b\\': 1 },
]

/**
 * The tool calls over each record of the ops fixture: the addresses its list
 * rows name, and over the record with no workspace every argument above.
 */
async function recordCalls(): Promise<Message[]> {
  const rows: Message[] = []
  let id = 0
  let send: ((message: Message) => Promise<Message>) | undefined
  const call = async (record: unknown, args: Message | undefined) => {
    id += 1
    const params =
      args === undefined
        ? { name: 'wb_document_list' }
        : { name: 'wb_document_list', arguments: args }
    if (send === undefined) throw new Error('a call before any record')
    const answer = await send({ jsonrpc: '2.0', id, method: 'tools/call', params })
    rows.push({ case: record, params, answer: answer.result ?? { error: answer.error } })
  }
  for (const row of await rowsOf(READS)) {
    const record = recordOf(row)
    if (record !== undefined) {
      send = await session(await createMcpServer(await depsOver(record)))
      rows.push(row)
      // Validation answers before any record is read, so one record carries it.
      if (record.case === 'no-workspace') {
        for (const args of LIST_ARGUMENTS) await call(record.case, args)
      }
    } else if (row.op === 'list' && row.case !== 'no-workspace') {
      await call(row.case, { workspaceId: row.workspaceId })
    }
  }
  return rows
}

const contractFile = (name: string) => join(CONTRACTS, `${name}.json`)

describe('the tool contracts', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
  })

  it('are what the TypeScript server lists, tool for tool', async () => {
    const tools = await listedTools(await resolveTestServerDeps(join(tmp.dir, 'data')))
    if (RECORD) {
      await mkdir(CONTRACTS, { recursive: true })
      for (const tool of tools) {
        await writeFile(contractFile(tool.name as string), `${JSON.stringify(tool, null, 2)}\n`)
      }
    }
    const files = (await readdir(CONTRACTS)).filter((file) => file.endsWith('.json')).sort()
    const names = tools.map((tool) => tool.name as string)
    expect(files).toEqual(names.map((name) => `${name}.json`).sort())
    expect([...names].sort()).toEqual([...ALL_REGISTERED_TOOLS].sort())
    for (const tool of tools) {
      // Normalised by a parse: the formatter may wrap a file, never reorder it.
      const held = JSON.parse(await readFile(contractFile(tool.name as string), 'utf8'))
      expect(JSON.stringify(held), `${tool.name}`).toBe(JSON.stringify(tool))
    }
  })

  it('hold every operation the Rust ops layer replays as server-core answers it', async () => {
    const answered = await recordReads()
    if (RECORD) await writeRows(READS, answered)
    expect(await rowsOf(READS)).toEqual(answered)
  })

  it('hold every tool call the Rust adapter replays as the TypeScript answers it', async () => {
    const answered = await recordCalls()
    if (RECORD) await writeRows(CALLS, answered)
    expect(await rowsOf(CALLS)).toEqual(answered)
  })
})
