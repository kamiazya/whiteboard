import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { base64ToBytes } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
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
 * The second recording, `oracle/tool-calls.jsonl`, is the TypeScript's
 * answers to `tools/call` for the tools the Rust ops layer implements:
 * successes, refusals and the SDK's own validation failures, replayed by
 * `crates/adapters/mcp/tests/tool_calls.rs`. Its inputs ride in it — each
 * `snapshot` row is a workspace record, the ones the ops crate's own fixture
 * holds (the Rust test holds the two equal) — so this test reads nothing but
 * the recording to answer them again.
 *
 * Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node tool-contracts.oracle`,
 * then `pnpm exec biome format --write contracts/tools` (the comparison is of
 * parsed JSON, so the formatter's wrapping is no difference).
 */
const CONTRACTS = join(repoRoot(), 'contracts', 'tools')
const CALLS = new URL('./oracle/tool-calls.jsonl', import.meta.url)
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

/** The recording's rows, inputs and answers alike. */
async function recorded(): Promise<Message[]> {
  return (await readFile(CALLS, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Message)
}

/** The workspace records the recording holds, by case. */
async function records(): Promise<{ case: string; snapshot: string | null }[]> {
  return (await recorded()).flatMap((row) =>
    row.snapshot === undefined
      ? []
      : [{ case: row.case as string, snapshot: row.snapshot as string | null }],
  )
}

/** The index over one record, its registry holding the workspace only when the record exists. */
function indexOver(snapshot: string | null): LoroWorkspaceDocumentIndex {
  const bytes = snapshot === null ? null : base64ToBytes(snapshot)
  if (snapshot !== null && bytes === null)
    throw new Error(`a snapshot that is not base64: ${snapshot}`)
  const docs = {
    open: async () => (bytes === null ? null : LoroDoc.fromSnapshot(bytes)),
    create: () => Promise.reject(new Error('a read creates nothing')),
    save: () => Promise.reject(new Error('a read saves nothing')),
    readCursor: () => Promise.reject(new Error('not read')),
    catchUp: () => Promise.reject(new Error('not read')),
    storedVersion: () => Promise.reject(new Error('not read')),
  }
  const registry: WorkspaceRegistry = {
    listWorkspaces: async () => (snapshot === null ? [] : [{ workspaceId: W }]),
    findWorkspace: async (lookup) =>
      snapshot !== null && 'workspaceId' in lookup && lookup.workspaceId === W
        ? { workspaceId: W }
        : null,
    renameWorkspace: () => Promise.reject(new Error('a read renames nothing')),
  }
  return new LoroWorkspaceDocumentIndex(docs, {} as never, registry)
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

async function recordCalls(): Promise<Message[]> {
  const base = await resolveTestServerDeps(join(tmp.dir, 'data'))
  const rows: Message[] = []
  let id = 0
  for (const record of await records()) {
    const deps = {
      ...base,
      documentIndex: indexOver(record.snapshot),
      knownWorkspaceHandles: undefined,
      callerNamespace: undefined,
    }
    const send = await session(await createMcpServer(deps))
    rows.push({ case: record.case, snapshot: record.snapshot })
    // Validation answers before any record is read, so one record carries it.
    const corpus = record.snapshot === null ? LIST_ARGUMENTS : [{ workspaceId: W }]
    for (const args of corpus) {
      id += 1
      const params =
        args === undefined
          ? { name: 'wb_document_list' }
          : { name: 'wb_document_list', arguments: args }
      const answer = await send({ jsonrpc: '2.0', id, method: 'tools/call', params })
      rows.push({ case: record.case, params, answer: answer.result ?? { error: answer.error } })
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

  it('hold every tool call the Rust adapter replays as the TypeScript answers it', async () => {
    const answered = await recordCalls()
    if (RECORD) await writeFile(CALLS, `${answered.map((row) => JSON.stringify(row)).join('\n')}\n`)
    expect(await recorded()).toEqual(answered)
  })
})
