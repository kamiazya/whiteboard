import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

/**
 * `wb_document_search` as the daemon answers it, lexical alone (no
 * embedder is configured unless `WHITEBOARD_SEMANTIC_SEARCH` opts in): the
 * recording the Rust ops layer's `DocumentSearch` is replayed against
 * (`crates/adapters/mcp/tests/document_search.rs`).
 *
 * `oracle/document-search.jsonl` opens with one record row: the one
 * workspace's record (`snapshot`, kept as `W`), the registry rows that
 * address it, the caller's namespace and the handles a refusal may name. The
 * record was built once through the daemon's own tools: notes in folders,
 * one of them named; a board with text, link, group and file nodes and
 * labelled and unlabelled edges; tags on notes, the board, nodes and an
 * edge; emoji shown and written as shortcodes; Japanese; links that an
 * excerpt labels; and documents with no text to open with. Delete the file
 * to build it again (the ids are minted, and the answers name them).
 *
 * Every row after it is one `tools/call` and the result it drew, answered
 * over a fresh data directory the record was loaded into, its
 * `structuredContent` held as `structured: true` once it is shown to be what
 * its text spells. Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node document-search.oracle`.
 */
const FIXTURE = new URL('./oracle/document-search.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'
const KNOWN = [SEGMENT]

const tmp = withTempDataDir('whiteboard-mcp-document-search-')

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

/** The structured answer of a call that must succeed. */
async function ok(call: Call, name: string, args: Message): Promise<Message> {
  const answer = await call(name, args)
  if (answer.isError === true || answer.error !== undefined) {
    throw new Error(`${name} failed while building the record: ${JSON.stringify(answer)}`)
  }
  return answer.structuredContent as Message
}

const LONG_OPENING = `${'An opening line that runs on well past the cut an excerpt of a document makes, '.repeat(3)}and ends here.`

const NOTES: readonly Message[] = [
  {
    path: 'plans/launch',
    name: 'Launch plan',
    markdown:
      '# Rocket launch\n\nThe rocket 🚀 launches at dawn. Ground crew read [[plans/window]] first, and the checklist [[ops/checklist]].\n\nAfter the launch the crew rests.',
  },
  {
    path: 'plans/window',
    name: 'Launch window',
    markdown:
      'The launch window opens at 06:00 and closes at 06:40. Weather decides the launch.\n\nSee also [[nowhere/at-all]].',
  },
  {
    path: 'ops/checklist',
    markdown: 'Fuel, oxygen, telemetry. A rocket checklist, read aloud.',
  },
  { path: 'ops/handover', markdown: 'Handover notes for the night shift.' },
  {
    path: 'ja/uchiage',
    name: '打ち上げ計画',
    markdown: 'ロケットの打ち上げは明日の朝です。天気が良ければ打ち上げます。',
  },
  { path: 'party', markdown: '🎉🎉🎉\n\nCake at four.' },
  { path: 'fire-drill', markdown: 'Drill today :fire: — leave by the east stairs.' },
  { path: 'long-opening', markdown: `${LONG_OPENING}\n\nThe rocket is mentioned once.` },
  { path: 'blank' },
  { path: 'whitespace', markdown: '   \n\n   ' },
  { path: 'archive/2020/old', markdown: 'An old launch report, long superseded.' },
]

/** Documents, folders, a board and tags, written through the tools. */
async function populate(call: Call): Promise<void> {
  const created = await ok(call, 'wb_workspace_edit', {
    workspaceId: W,
    ops: [
      ...NOTES.map((note) => ({ op: 'document.create', kind: 'markdown', ...note })),
      { op: 'document.create', path: 'plans/board', kind: 'spatial', name: 'Launch board' },
      { op: 'document.create', path: 'empty-board', kind: 'spatial' },
      { op: 'folder.rename', path: 'ops', name: 'Operations Team' },
      { op: 'folder.rename', path: 'archive/2020', name: 'Year of the rocket' },
    ],
  })
  const ids: Record<string, string> = {}
  for (const result of created.results as { path?: string; documentId?: string }[]) {
    if (result.path !== undefined && result.documentId !== undefined) {
      ids[result.path] = result.documentId
    }
  }
  const board = ids['plans/board'] as string
  await ok(call, 'wb_canvas_edit', {
    workspaceId: W,
    documentId: board,
    mode: 'apply',
    ops: [
      { op: 'node.add', node: { id: 'blank', type: 'text', text: '  ', x: 0, y: -200 } },
      { op: 'node.add', node: { id: 'pad', type: 'text', text: 'Launch pad', x: 0, y: 0 } },
      { op: 'node.add', node: { id: 'tower', type: 'text', text: 'Tower', x: 300, y: 0 } },
      { op: 'node.add', node: { id: 'unlabelled', type: 'text', text: '', x: 600, y: 0 } },
      {
        op: 'node.add',
        node: { id: 'site', type: 'link', url: 'https://launch.example/rocket', x: 0, y: 300 },
      },
      {
        op: 'node.add',
        node: {
          id: 'g',
          type: 'group',
          label: 'Ground crew',
          x: -400,
          y: 500,
          width: 300,
          height: 200,
        },
      },
      { op: 'node.add', node: { id: 'f', type: 'file', file: 'plans/launch', x: 600, y: 300 } },
      {
        op: 'edge.add',
        edge: { id: 'fuels', from: { node: 'pad' }, to: { node: 'tower' }, label: 'fuels' },
      },
      { op: 'edge.add', edge: { id: 'bare', from: { node: 'tower' }, to: { node: 'site' } } },
      {
        op: 'edge.add',
        edge: { id: 'blank-end', from: { node: 'unlabelled' }, to: { node: 'pad' } },
      },
    ],
  })
  const tag = (documentIds: string[], add: string[], at: Message = {}) =>
    ok(call, 'wb_facet_set', { workspaceId: W, documentIds, tags: { add }, ...at })
  await tag([ids['plans/launch'] as string, ids['plans/window'] as string], ['launch', 'q3'])
  await tag([ids['ops/checklist'] as string], ['launch', 'safety'])
  await tag([ids.party as string], ['social'])
  await tag([board], ['launch', 'board-only'])
  await tag([board], ['safety', 'q3'], { nodeId: 'pad' })
  await tag([board], ['safety'], { nodeId: 'tower' })
  await tag([board], ['q3'], { nodeId: 'unlabelled' })
  await tag([board], ['safety', 'flow'], { edgeId: 'fuels' })
  await tag([board], ['flow'], { edgeId: 'bare' })
  await tag([board], ['flow', 'q3'], { edgeId: 'blank-end' })
}

/** The record the calls are answered over, built through the tools. */
async function buildRecord(): Promise<Message> {
  const deps = await freshDeps(KNOWN)
  await populate(await caller(deps))
  const record = await workspaceRecordCopy(W)
  const registry = (await deps.documentIndex.listWorkspaces()).filter(
    (row) => row.workspaceId === W,
  )
  return {
    case: 'workspace',
    snapshot: bytesToBase64(record.export({ mode: 'snapshot' })),
    registry,
    callerNamespace: (await deps.callerNamespace?.()) ?? 'me',
    known: KNOWN,
  }
}

const q = (query: string, more: Message = {}): Message => ({ workspaceId: W, query, ...more })

/** Words to match, alone or with a limit. */
function queryCalls(): [string, Message][] {
  return [
    ['a word many documents say', q('launch')],
    ['a word, the top one alone', q('launch', { limit: 1 })],
    ['a word, every hit', q('launch', { limit: 50 })],
    ['two words', q('rocket crew')],
    ['a word in an edge label', q('fuels')],
    ['a word in a group label', q('ground')],
    ['a word in a link node', q('example')],
    ['a word a name says', q('plan')],
    ['a word a path says', q('archive')],
    ['a word only a folder name says', q('operations')],
    ['a folder name and a word', q('team handover')],
    ['a nested folder name', q('year')],
    ['a word an emoji shows', q('party')],
    ['a word a shortcode writes', q('fire')],
    ['an emoji itself', q('🚀')],
    ['Japanese', q('打ち上げ')],
    ['one Japanese character', q('天')],
    ['katakana', q('ロケット')],
    ['a word linked text names', q('window')],
    ['case and accents', q('ROCKÉT')],
    ['a word nothing says', q('zeppelin')],
    ['punctuation alone', q('!!!')],
    ['a repeated word', q('launch launch launch')],
    ['a long query', q(`${'telemetry '.repeat(100)}rocket`)],
  ]
}

/** Filters, with words and alone. */
function filterCalls(): [string, Message][] {
  const w = { workspaceId: W }
  return [
    ['markdown documents saying a word', q('launch', { kind: 'markdown' })],
    ['spatial documents saying a word', q('launch', { kind: 'spatial' })],
    ['every spatial document', { ...w, kind: 'spatial' }],
    ['every markdown document', { ...w, kind: 'markdown' }],
    ['every markdown document, three', { ...w, kind: 'markdown', limit: 3 }],
    ['a tag notes and a board carry', { ...w, tags: ['launch'] }],
    ['a tag nodes and notes carry', { ...w, tags: ['safety'] }],
    ['two tags one node carries', { ...w, tags: ['safety', 'q3'] }],
    ['two tags carried apart', { ...w, tags: ['launch', 'safety'] }],
    ['a tag the edges carry', { ...w, tags: ['flow'] }],
    ['a tag an unlabelled node carries', { ...w, tags: ['q3'] }],
    ['a tag repeated', { ...w, tags: ['flow', 'flow'] }],
    ['a tag nothing carries', { ...w, tags: ['nope'] }],
    ['a tag, spatial', { ...w, tags: ['q3'], kind: 'spatial' }],
    ['a tag and words', q('launch', { tags: ['launch'] })],
    ['a tag and words nothing else says', q('fuels', { tags: ['safety'] })],
    ['a tag, words and a kind', q('rocket', { tags: ['launch'], kind: 'markdown' })],
    ['a tag on one note alone', { ...w, tags: ['social'] }],
  ]
}

/** Addresses and refusals. */
function workspaceCalls(): [string, Message | undefined][] {
  return [
    ['a workspace by segment', { workspaceId: SEGMENT, query: 'rocket' }],
    ['a workspace by namespace and segment', { workspaceId: `me/${SEGMENT}`, query: 'rocket' }],
    ['nothing to search for', { workspaceId: W }],
    ['nothing to search for, a limit', { workspaceId: W, limit: 5 }],
    ['a workspace nothing answers to', { workspaceId: 'nope', query: 'rocket' }],
    ['an unknown workspace, nothing to search', { workspaceId: 'nope' }],
    ['an id nothing answers to', { workspaceId: '01BX5ZZKBKACTAV9WEVGEMMVRZ', query: 'x' }],
  ]
}

/** Arguments the SDK refuses before the tool runs. */
function validationCalls(): [string, Message | undefined][] {
  const w = { workspaceId: W }
  return [
    ['no arguments', undefined],
    ['empty arguments', {}],
    ['an empty query', { ...w, query: '' }],
    ['a query not a string', { ...w, query: 7 }],
    ['a null query', { ...w, query: null }],
    ['a query past its limit', { ...w, query: 'x'.repeat(1025) }],
    ['a query at its limit', { ...w, query: 'x'.repeat(1024) }],
    ['a query past its limit in units', { ...w, query: '🚀'.repeat(513) }],
    ['a kind the model has not', { ...w, kind: 'pdf' }],
    ['a kind not a string', { ...w, kind: 1 }],
    ['no tags', { ...w, tags: [] }],
    ['an empty tag', { ...w, tags: ['ok', ''] }],
    ['a tag not a string', { ...w, tags: [3] }],
    ['tags as a string', { ...w, tags: 'launch' }],
    ['an empty string as tags', { ...w, tags: '' }],
    ['a long string as tags', { ...w, tags: 'x'.repeat(1025) }],
    ['tags past the limit', { ...w, tags: Array.from({ length: 1025 }, () => 't') }],
    ['tags at the limit', { ...w, tags: Array.from({ length: 1024 }, () => 't') }],
    ['a zero limit', { ...w, query: 'x', limit: 0 }],
    ['a limit past fifty', { ...w, query: 'x', limit: 51 }],
    ['a fractional limit', { ...w, query: 'x', limit: 1.5 }],
    ['a fractional limit under one', { ...w, query: 'x', limit: 0.5 }],
    ['a negative limit', { ...w, query: 'x', limit: -3 }],
    ['a huge limit', { ...w, query: 'x', limit: 1e300 }],
    ['a huge negative limit', { ...w, query: 'x', limit: -1e300 }],
    ['an unsafe integer limit', { ...w, query: 'x', limit: 9007199254740993 }],
    ['a limit as text', { ...w, query: 'x', limit: '10' }],
    ['a null limit', { ...w, query: 'x', limit: null }],
    ['an unknown key', { ...w, query: 'x', tag: 'launch' }],
    ['a workspace not a string', { workspaceId: 7, query: 'x' }],
    [
      'every field wrong',
      { workspaceId: {}, query: '', kind: 'Markdown', tags: [''], limit: 0, extra: 1 },
    ],
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

/** Every call, answered by a daemon the record was loaded into. */
async function answer(record: Message): Promise<Message[]> {
  const deps = await freshDeps(KNOWN)
  await importWorkspaceRecord(
    W,
    LoroDoc.fromSnapshot(base64ToBytes(record.snapshot as string) as Uint8Array),
  )
  const call = await caller(deps)
  const rows: Message[] = [record]
  const calls = [...queryCalls(), ...filterCalls(), ...workspaceCalls(), ...validationCalls()]
  for (const [about, args] of calls) {
    const name = 'wb_document_search'
    const params = args === undefined ? { name } : { name, arguments: args }
    rows.push({ case: about, params, answer: textOnly(await call(name, args)) })
  }
  return rows
}

describe('wb_document_search over a workspace of notes, a board and tags', () => {
  it('answers every recorded call as the recording holds it', { timeout: 120_000 }, async () => {
    const held = (await exists(FIXTURE)) ? (await rowsOf(FIXTURE))[0] : undefined
    const record = held?.snapshot === undefined ? await buildRecord() : held
    const answered = await answer(record)
    if (RECORD || held?.snapshot === undefined) {
      await writeFile(FIXTURE, `${answered.map((row) => JSON.stringify(row)).join('\n')}\n`)
    }
    expect(await rowsOf(FIXTURE)).toEqual(answered)
  })
})
