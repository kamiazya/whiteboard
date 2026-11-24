import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

/**
 * `wb_facet_list` as the daemon answers it: the recording the Rust ops
 * layer's `FacetList` is replayed against
 * (`crates/adapters/mcp/tests/facet_list.rs`).
 *
 * `oracle/facet-list.jsonl` opens with one record row: the registry rows that
 * address the one workspace, `W` (an empty one: what a workspace's own
 * library and tags add is a later recording's), the caller's namespace and
 * the handles a refusal may name. Every row after it is one `tools/call` and
 * the result it drew, its `structuredContent` held as `structured: true`
 * once it is shown to be what its text spells. Nothing here is minted, so a
 * rerun answers the same rows; re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node facet-list.oracle`.
 */
const FIXTURE = new URL('./oracle/facet-list.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'
const KNOWN = [SEGMENT]

const tmp = withTempDataDir('whiteboard-mcp-facet-list-')

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

const TARGETS = ['document', 'canvas', 'node', 'edge']
const ASSET_KINDS = ['themes', 'icons', 'stencils']

/** The lists the recording answers, by what each one is about. */
function listCalls(): [string, Message | undefined][] {
  return [
    ['no arguments', undefined],
    ['empty arguments', {}],
    ...TARGETS.map((target): [string, Message] => [`target ${target}`, { target }]),
    ...ASSET_KINDS.map((assetKind): [string, Message] => [`assets ${assetKind}`, { assetKind }]),
    ['a target and an asset kind', { target: 'edge', assetKind: 'themes' }],
  ]
}

/** Calls naming a workspace: resolved first, as every tool resolves one. */
function workspaceCalls(): [string, Message | undefined][] {
  return [
    ['a workspace by id', { workspaceId: W }],
    ['a workspace by segment, filtered', { workspaceId: SEGMENT, target: 'node' }],
    ['a workspace by namespace and segment', { workspaceId: `me/${SEGMENT}` }],
    ['a workspace nothing answers to', { workspaceId: 'nope' }],
    ['an id nothing answers to', { workspaceId: '01BX5ZZKBKACTAV9WEVGEMMVRZ' }],
    ['an empty address', { workspaceId: '' }],
    ['an address no form spells', { workspaceId: 'a_b/c/d', assetKind: 'icons' }],
  ]
}

/** Arguments the SDK refuses before the tool runs. */
function validationCalls(): [string, Message | undefined][] {
  return [
    ['a target the engine has not', { target: 'workspace' }],
    ['a target not a string', { target: 1 }],
    ['a null target', { target: null }],
    ['an asset kind the engine has not', { assetKind: 'fonts' }],
    ['a workspace not a string', { workspaceId: 7 }],
    ['an unknown key', { kind: 'node' }],
    ['every field wrong', { target: 'Node', assetKind: [], workspaceId: {}, extra: 1 }],
  ]
}

/**
 * A result with its `structuredContent` left out once it is shown to be what
 * its text spells, which is how the tool wrapper writes the text.
 */
function textOnly(answer: Message): Message {
  const { structuredContent, ...rest } = answer
  if (structuredContent === undefined) return answer
  const [first] = answer.content as { text: string }[]
  expect(first?.text).toBe(JSON.stringify(structuredContent))
  return { ...rest, structured: true }
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

/** Every call, answered by a daemon holding the one workspace. */
async function answer(): Promise<Message[]> {
  const deps = await freshDeps(KNOWN)
  const registry = (await deps.documentIndex.listWorkspaces()).filter(
    (row) => row.workspaceId === W,
  )
  const record = {
    case: 'deployment',
    registry,
    callerNamespace: (await deps.callerNamespace?.()) ?? 'me',
    known: KNOWN,
  }
  const call = await caller(deps)
  const rows: Message[] = [record]
  for (const [about, args] of [...listCalls(), ...workspaceCalls(), ...validationCalls()]) {
    const params =
      args === undefined ? { name: 'wb_facet_list' } : { name: 'wb_facet_list', arguments: args }
    rows.push({ case: about, params, answer: textOnly(await call('wb_facet_list', args)) })
  }
  return rows
}

describe('wb_facet_list over the deployment registry', () => {
  it('answers every recorded call as the recording holds it', { timeout: 120_000 }, async () => {
    const answered = await answer()
    if (RECORD || !(await exists(FIXTURE))) {
      await writeFile(FIXTURE, `${answered.map((row) => JSON.stringify(row)).join('\n')}\n`)
    }
    expect(await rowsOf(FIXTURE)).toEqual(answered)
  })
})
