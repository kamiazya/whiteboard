import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server'
import { LoroDoc, LoroMap, LoroText, type LoroTree } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

/**
 * `wb_document_get` over a workspace record WITH content, as the daemon
 * answers it: the recording the Rust ops layer's `DocumentGet` is replayed
 * against (`crates/adapters/mcp/tests/document_get.rs`).
 *
 * `oracle/document-get.jsonl` opens with one record row: a workspace record
 * (`snapshot`, kept as `W`), the registry rows that address it, the caller's
 * namespace, the handles a refusal may name, and the ids of the documents it
 * holds by name. It was built once, through the daemon's own tools over a
 * real data directory — markdown with frontmatter, facets and a trust event,
 * a bare body, an empty note, comment threads and a proposal, bodies sized to
 * reach the response budget, spatial documents — and then by direct edits of
 * the record for what no tool writes any more (a retired stored shape, a
 * document with no kind). Delete the file to build it again: the ids and
 * stamps are minted, so a rebuild changes every row.
 *
 * Every row after it is one `tools/call` and the result it drew, answered
 * over a fresh data directory the record was loaded into. Re-record after a
 * deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project mcp-node document-get.oracle`.
 */
const FIXTURE = new URL('./oracle/document-get.jsonl', import.meta.url)
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'notes'

const tmp = withTempDataDir('whiteboard-mcp-document-get-')

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
const { editWorkspaceRecord, importWorkspaceRecord, workspaceRecordCopy } = await import(
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

async function freshDeps(): Promise<ServerDeps> {
  const deps = await resolveTestServerDeps(join(tmp.dir, 'data'))
  await deps.documentIndex.createWorkspace({ workspaceId: W, segment: SEGMENT })
  return deps
}

/** The structured answer of a call that must succeed. */
async function ok(call: Call, name: string, args: Message): Promise<Message> {
  const answer = await call(name, args)
  if (answer.isError === true || answer.error !== undefined) {
    throw new Error(`${name} failed while building the record: ${JSON.stringify(answer)}`)
  }
  return answer.structuredContent as Message
}

const repeat = (text: string, length: number) =>
  text.repeat(Math.ceil(length / text.length)).slice(0, length)

// A facet payload's keys reach the TypeScript in npm loro-crdt's map order,
// which differs between two loads of the same record, so each payload here
// holds one string key (integer-like keys enumerate in order whatever loro
// hands over).
const NOTE = `---
type: plan
tags: [alpha, "beta"]
2: integer-like key
created: 2020-01-02
facets:
  x.custom/v1: { values: [1.5, 1e21, 0.000001, -0, 1, "two", null, true] }
  a.first/v1: { "10": ten, "9": nine, name: "quote \\" and \\\\ and é and 🎨" }
---

# Plan

Body with **marks** and a [[link]].
`

/** The documents the record holds, by path. */
const DOCUMENTS: Message[] = [
  { op: 'document.create', path: 'plan', kind: 'markdown', name: 'Plan', markdown: NOTE },
  { op: 'document.create', path: 'bare', kind: 'markdown', markdown: 'just a body\n' },
  { op: 'document.create', path: 'empty', kind: 'markdown' },
  { op: 'document.create', path: 'commented', kind: 'markdown', markdown: 'Alpha beta gamma.' },
  { op: 'document.create', path: 'big-1', kind: 'markdown', markdown: repeat('a', 262144) },
  { op: 'document.create', path: 'big-2', kind: 'markdown', markdown: repeat('b', 262144) },
  { op: 'document.create', path: 'big-3', kind: 'markdown', markdown: repeat('c', 262144) },
  { op: 'document.create', path: 'big-4', kind: 'markdown', markdown: repeat('d', 262144) },
  { op: 'document.create', path: 'talkative', kind: 'markdown', markdown: repeat('t', 262144) },
  { op: 'document.create', path: 'retired', kind: 'markdown' },
  { op: 'document.create', path: 'old-comments', kind: 'markdown', markdown: 'said' },
  { op: 'document.create', path: 'kindless', kind: 'markdown' },
  { op: 'document.create', path: 'kindless-retired', kind: 'markdown' },
  { op: 'document.create', path: 'stripped', kind: 'markdown', markdown: 'no envelope' },
  { op: 'document.create', path: 'board', kind: 'spatial', name: 'Board' },
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

/** Comments and proposals through the tools. */
async function annotate(call: Call, ids: Record<string, string>): Promise<void> {
  await ok(call, 'wb_thread_edit', {
    workspaceId: W,
    documentId: ids.commented,
    ops: [
      {
        op: 'thread.add',
        threadId: 't1',
        anchor: { kind: 'document' },
        body: 'Looks right.',
        author: 'human:ana',
      },
      {
        op: 'thread.add',
        threadId: 't2',
        anchor: { kind: 'text', quote: { exact: 'beta' }, start: 6, end: 10 },
        body: 'Why "beta"?',
        author: 'claude-code/2.1',
      },
      { op: 'message.add', threadId: 't2', body: 'Because.', author: 'human:ana' },
      { op: 'thread.resolve', threadId: 't1' },
    ],
  })
  await ok(call, 'wb_body_edit', {
    workspaceId: W,
    documentId: ids.commented,
    proposalId: 'p1',
    author: 'claude-code/2.1',
    ops: [
      {
        id: 'c1',
        op: 'body.replace',
        anchor: { kind: 'text', quote: { exact: 'gamma' }, start: 11, end: 16 },
        text: 'delta',
        assumed: 'gamma',
      },
    ],
  })
  await crowd(call, ids)
}

/** Enough comment to put `talkative` alone over the response budget, and a board's node. */
async function crowd(call: Call, ids: Record<string, string>): Promise<void> {
  const threads = Array.from({ length: 200 }, (_, n) => ({
    op: 'thread.add',
    threadId: `long-${n}`,
    anchor: { kind: 'document' },
    body: repeat(`${n} `, 4096),
    author: 'human:ana',
  }))
  await ok(call, 'wb_thread_edit', { workspaceId: W, documentId: ids.talkative, ops: threads })
  await ok(call, 'wb_canvas_edit', {
    workspaceId: W,
    documentId: ids.board,
    ops: [{ op: 'node.add', node: { id: 'n1', type: 'text', text: 'hello', x: 0, y: 0 } }],
  })
}

/** Creates the documents through the tools, then edits what no tool writes. */
async function buildRecord(): Promise<Message> {
  const deps = await freshDeps()
  const call = await caller(deps)
  const ids = await createDocuments(call)
  await annotate(call, ids)
  await editWorkspaceRecord(W, (copy) => retireAndForget(copy, ids))
  const record = await workspaceRecordCopy(W)
  const registry = (await deps.documentIndex.listWorkspaces()).filter(
    (row) => row.workspaceId === W,
  )
  return {
    case: 'content',
    snapshot: bytesToBase64(record.export({ mode: 'snapshot' })),
    registry,
    callerNamespace: (await deps.callerNamespace?.()) ?? 'me',
    known: null,
    ids,
  }
}

/** The tree node meta map that hosts `documentId`. */
function hostOf(copy: LoroDoc, documentId: string): LoroMap {
  const tree = copy.getTree('tree') as LoroTree
  const node = tree.getNodes().find((each) => each.data.get('documentId') === documentId)
  if (node === undefined) throw new Error(`no node hosts ${documentId}`)
  return node.data
}

/**
 * What no tool writes any more: `retired` holds its body as a canvas text
 * node, as an older writer stored it; `old-comments` holds comments in the
 * flat plane before threads; `kindless` loses the kind its own content
 * records, as a document from before kinds holds none (its index row keeps
 * one, since a node without a kind is no document, and the read falls back
 * to it); `kindless-retired` is both, which the retired-shape question,
 * asked without a kind, cannot name; and `stripped` holds neither core nor
 * trust facets, as a document from before them.
 */
function retireAndForget(copy: LoroDoc, ids: Record<string, string>): void {
  holdBodyInNode(hostOf(copy, ids.retired))
  const comments = hostOf(copy, ids['old-comments']).setContainer('comments', new LoroMap())
  comments.set('c1', { id: 'c1', body: 'flat' })
  comments.set('c2', { id: 'c2', body: 'plane' })
  forgetKind(hostOf(copy, ids.kindless))
  const kindlessRetired = hostOf(copy, ids['kindless-retired'])
  forgetKind(kindlessRetired)
  holdBodyInNode(kindlessRetired)
  const stripped = hostOf(copy, ids.stripped)
  stripped.delete('core')
  stripped.delete('trust')
}

/** An empty body, and the text in a canvas text node instead. */
function holdBodyInNode(host: LoroMap): void {
  const body = host.get('body')
  if (body instanceof LoroText) body.delete(0, body.length)
  const nodes = host.setContainer('nodes', new LoroMap())
  nodes.set('n1', { id: 'n1', resource: { mimeType: 'text/markdown', content: 'old body' } })
}

function forgetKind(host: LoroMap): void {
  const document = host.get('document')
  if (document instanceof LoroMap) document.delete('kind')
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

/** The reads the recording answers, by what each one is about. */
function readCalls(ids: Record<string, string>): [string, Message | undefined][] {
  return [
    ['one markdown document with everything', { workspaceId: W, documentIds: [ids.plan] }],
    ['by segment', { workspaceId: SEGMENT, documentIds: [ids.bare] }],
    ['an empty note', { workspaceId: W, documentIds: [ids.empty] }],
    ['threads and a proposal', { workspaceId: W, documentIds: [ids.commented] }],
    [
      'several, in order, a repeat once',
      { workspaceId: W, documentIds: [ids.bare, ids.plan, ids.bare] },
    ],
    [
      'one nothing holds',
      { workspaceId: W, documentIds: ['01BX5ZZKBKACTAV9WEVGEMMVRZ', ids.bare] },
    ],
    ['a retired shape', { workspaceId: W, documentIds: [ids.retired] }],
    ['a document with no kind', { workspaceId: W, documentIds: [ids.kindless] }],
    ['no kind and a retired shape', { workspaceId: W, documentIds: [ids['kindless-retired']] }],
    ['no core or trust facets', { workspaceId: W, documentIds: [ids.stripped] }],
    [
      'strict options on markdown',
      { workspaceId: W, documentIds: [ids.bare], options: { strict: true } },
    ],
    ['empty options', { workspaceId: W, documentIds: [ids.bare], options: {} }],
    [
      'the budget, reached',
      {
        workspaceId: W,
        documentIds: [ids['big-1'], ids['big-2'], ids['big-3'], ids['big-4'], ids.bare, ids.plan],
      },
    ],
    [
      'one alone over the budget',
      { workspaceId: W, documentIds: [ids.talkative, '01BX5ZZKBKACTAV9WEVGEMMVRZ', ids.bare] },
    ],
    [
      'comments in the retired plane',
      { workspaceId: W, documentIds: [ids.bare, ids['old-comments']] },
    ],
    ['a spatial document', { workspaceId: W, documentIds: [ids.board] }],
    [
      'a spatial document, strict',
      { workspaceId: W, documentIds: [ids.board], options: { strict: true } },
    ],
    ['a workspace nothing answers to', { workspaceId: 'nope', documentIds: [ids.bare] }],
  ]
}

/** Arguments the SDK refuses before the tool runs, and one it lets through. */
function validationCalls(ids: Record<string, string>): [string, Message | undefined][] {
  const many = Array.from({ length: 21 }, () => ids.plan)
  return [
    ['no arguments', undefined],
    ['no documents', { workspaceId: W }],
    ['an empty list', { workspaceId: W, documentIds: [] }],
    ['twenty-one', { workspaceId: W, documentIds: many }],
    ['twenty-one with a bad item first', { workspaceId: W, documentIds: ['x', ...many.slice(1)] }],
    ['twenty-one with a bad item', { workspaceId: W, documentIds: [...many.slice(1), 'x'] }],
    ['an empty string', { workspaceId: W, documentIds: '' }],
    ['a number for the list', { workspaceId: W, documentIds: 7 }],
    ['twenty', { workspaceId: W, documentIds: many.slice(1) }],
    ['not a list', { workspaceId: W, documentIds: ids.plan }],
    ['an id that is no ULID', { workspaceId: W, documentIds: ['nope'] }],
    ['a lowercase ULID', { workspaceId: W, documentIds: [ids.plan.toLowerCase()] }],
    ['a number in the list', { workspaceId: W, documentIds: [1, ids.plan] }],
    ['two bad items', { workspaceId: W, documentIds: [null, 'x'] }],
    ['options not an object', { workspaceId: W, documentIds: [ids.plan], options: 'strict' }],
    ['options null', { workspaceId: W, documentIds: [ids.plan], options: null }],
    [
      'strict not a boolean',
      { workspaceId: W, documentIds: [ids.plan], options: { strict: 'yes' } },
    ],
    ['an unknown option', { workspaceId: W, documentIds: [ids.plan], options: { pretty: true } }],
    ['an unknown key', { workspaceId: W, documentIds: [ids.plan], extra: 1 }],
    ['every field wrong', { workspaceId: 1, documentIds: {}, options: [], extra: 1 }],
    ['an empty list and a bad address', { workspaceId: 'a_b', documentIds: [] }],
  ]
}

/**
 * A result with its `structuredContent` left out once it is shown to be what
 * its text spells, which is how the tool wrapper writes the text: the answers
 * near the response budget are a megabyte each, and kept twice they would be
 * most of the file. The replay parses the text back for the structured half.
 */
function textOnly(answer: Message): Message {
  const { structuredContent, ...rest } = answer
  if (structuredContent === undefined) return answer
  const [first] = answer.content as { text: string }[]
  expect(first?.text).toBe(JSON.stringify(structuredContent))
  return { ...rest, structured: true }
}

/** Every call over the record, answered by a daemon the record was loaded into. */
async function answer(record: Message): Promise<Message[]> {
  const deps = await freshDeps()
  await importWorkspaceRecord(
    W,
    LoroDoc.fromSnapshot(base64ToBytes(record.snapshot as string) as Uint8Array),
  )
  const call = await caller(deps)
  const rows: Message[] = [record]
  const ids = record.ids as Record<string, string>
  for (const [about, args] of [...readCalls(ids), ...validationCalls(ids)]) {
    const params =
      args === undefined
        ? { name: 'wb_document_get' }
        : { name: 'wb_document_get', arguments: args }
    rows.push({ case: about, params, answer: textOnly(await call('wb_document_get', args)) })
  }
  return rows
}

describe('wb_document_get over a record with content', () => {
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
