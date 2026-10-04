/**
 * `wb_thread_edit` — the annotation layer's document-scoped surface
 * (ADR-0026 decision 6).
 *
 * The reason it exists rather than more `wb_canvas_edit` ops: those are
 * canvas-scoped, so an agent cannot comment on a MARKDOWN document at all.
 * That also breaks ADR-0025's "no removal on either side" symmetry for a
 * format with no canvas — a person can be given feedback there that an
 * agent has no way to answer.
 */
import {
  readAnnotations,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
  writeThreadMessage,
} from '@kamiazya/whiteboard-loro-adapter'
import type { AnnotationAnchor, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { loadDocument, saveDocumentSnapshot } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createThreadEditTool } from './thread-edit.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(store: FakeDocumentStore): ServerDeps {
  return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
}

const NOTE_BODY = 'why migration? a note about it'

async function seedMarkdown(store: FakeDocumentStore): Promise<void> {
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, NOTE_BODY)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    path: 'doc',
    kind: 'markdown',
  })
}

const BOARD: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 200, height: 60, text: 'Alpha beta' }),
    textNode({ id: 'b', x: 300, y: 0, width: 200, height: 60, text: 'Gamma' }),
    fileNode({ id: 'f', x: 600, y: 0, width: 200, height: 60, file: 'some/note' }),
  ],
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
}

async function seedBoard(store: FakeDocumentStore): Promise<void> {
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, BOARD)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
}

describe('wb_thread_edit', () => {
  test('opens a thread on a MARKDOWN document, which the canvas-scoped ops cannot reach', async () => {
    const store = new FakeDocumentStore()
    await seedMarkdown(store)
    const deps = makeDeps(store)

    const result = await createThreadEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        {
          op: 'thread.add',
          anchor: { kind: 'text', quote: { exact: 'migration' }, start: 4, end: 13 },
          body: 'this paragraph contradicts the one above',
          author: 'agent:reviewer',
        },
      ],
    })

    expect(result.threads).toHaveLength(1)
    const { doc } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    const stored = readAnnotations(doc)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.messages[0]).toMatchObject({
      body: 'this paragraph contradicts the one above',
      author: 'agent:reviewer',
    })
    expect(stored[0]?.anchor).toEqual({
      kind: 'text',
      quote: { exact: 'migration' },
      start: 4,
      end: 13,
    })
    expect(stored[0]?.status).toBe('open')
  })

  test('appends a message to an existing thread without disturbing the first', async () => {
    const store = new FakeDocumentStore()
    await seedMarkdown(store)
    const deps = makeDeps(store)
    const tool = createThreadEditTool(deps)

    const opened = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        {
          op: 'thread.add',
          anchor: { kind: 'text', quote: { exact: 'why' }, start: 0, end: 3 },
          body: 'why this?',
        },
      ],
    })
    const threadId = opened.threads[0]?.id as string

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'message.add', threadId, body: 'because of the migration', author: 'agent:me' }],
    })

    const { doc } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    const stored = readAnnotations(doc)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.messages.map((message) => message.body)).toEqual([
      'why this?',
      'because of the migration',
    ])
  })

  test('resolves and reopens, and offers no way to remove — the ADR-0025 symmetry', async () => {
    const store = new FakeDocumentStore()
    await seedMarkdown(store)
    const deps = makeDeps(store)
    const tool = createThreadEditTool(deps)

    const opened = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        {
          op: 'thread.add',
          anchor: { kind: 'text', quote: { exact: 'why' }, start: 0, end: 3 },
          body: 'a point',
        },
      ],
    })
    const threadId = opened.threads[0]?.id as string

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'thread.resolve', threadId }],
    })
    const afterResolve = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(readAnnotations(afterResolve.doc)[0]?.status).toBe('resolved')

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'thread.resolve', threadId, resolved: false }],
    })
    const afterReopen = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(readAnnotations(afterReopen.doc)[0]?.status).toBe('open')

    // The conversation is never deleted, by an agent or by a person. A
    // `thread.remove` here would be the asymmetry ADR-0025 decision 2 closed,
    // reopened one format over.
    const ops = tool.inputSchema.shape.ops.element.options.map(
      (option) => option.shape.op.value as string,
    )
    expect(ops).toEqual(['thread.add', 'message.add', 'thread.resolve'])
  })

  test('refuses a message on a thread the document does not hold, instead of opening one', async () => {
    const store = new FakeDocumentStore()
    await seedMarkdown(store)
    const deps = makeDeps(store)

    // Replying must never be the write that CREATES a container: two replicas
    // opening one under the same key with no common ancestor merge to one of
    // them, and the other side's messages are gone. `writeThreadMessage` is a
    // no-op there, so a silent accept would report success over a lost reply.
    await expect(
      createThreadEditTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [{ op: 'message.add', threadId: 'nope', body: 'into the void' }],
      }),
    ).rejects.toThrow(/nope/)
  })
})

/**
 * Two things the batch does that nothing asserted — both found by mutating
 * the handlers when the switch became a table.
 */
describe('wb_thread_edit within ONE batch', () => {
  test('a thread opened by an earlier op can be replied to by a later one', async () => {
    // `held.add(id)` after a create is what makes this work: without it the
    // reply is refused as "not on this document", and the whole point of a
    // batch tool is that the ops compose. Removing that one line left every
    // test green.
    const store = new FakeDocumentStore()
    await seedMarkdown(store)
    const deps = makeDeps(store)

    const result = await createThreadEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        {
          op: 'thread.add',
          threadId: 'th-batch',
          anchor: { kind: 'document' },
          body: 'opened in this batch',
        },
        { op: 'message.add', threadId: 'th-batch', body: 'replied in the same batch' },
      ],
    })

    expect(result.threads.map((thread) => [thread.id, thread.status])).toEqual([
      ['th-batch', 'open'],
    ])
    const { doc } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(readAnnotations(doc)[0]?.messages.map((m) => m.body)).toEqual([
      'opened in this batch',
      'replied in the same batch',
    ])
  })

  test('a reply is minted ABOVE the messages already there, never into a gap', async () => {
    // Minted from the COUNT rather than by scanning up from 1, because a
    // peer's reply that merged in leaves the two disagreeing — and an id
    // that lands in a gap overwrites someone else's message instead of
    // replying. The `while` loop alone does not give this: on a gapless
    // thread both spellings agree, which is why the gap below is seeded by
    // hand. The tool itself never makes one.
    const store = new FakeDocumentStore()
    await seedMarkdown(store)
    const deps = makeDeps(store)

    await createThreadEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'thread.add', threadId: 'th-1', anchor: { kind: 'document' }, body: 'first' }],
    })

    // A peer's reply that merged in at m3, leaving m2 unused — exactly the
    // state the comment in `message.add` describes.
    const { doc } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    writeThreadMessage(doc, 'th-1', {
      id: 'th-1-m3',
      body: 'from a peer',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await saveDocumentSnapshot(deps, WORKSPACE_ID, DOCUMENT_ID, doc)

    await createThreadEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'message.add', threadId: 'th-1', body: 'ours' }],
    })

    const { doc: after } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    const ours = readAnnotations(after)[0]?.messages.find((m) => m.body === 'ours')
    // m2 is free, and taking it would overwrite the slot the peer is most
    // likely to fill next.
    expect(ours?.id).toBe('th-1-m4')
  })

  test('returns each thread whole: anchor, status, and every message with its author and time', async () => {
    const store = new FakeDocumentStore()
    await seedMarkdown(store)
    const tool = createThreadEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [
        {
          op: 'thread.add',
          threadId: 'th-whole',
          anchor: { kind: 'text', quote: { exact: 'migration' }, start: 4, end: 13 },
          body: 'first remark',
          author: 'agent:reviewer',
        },
        { op: 'message.add', threadId: 'th-whole', body: 'second remark', author: 'agent:author' },
        { op: 'thread.resolve', threadId: 'th-whole' },
      ],
    })

    const [thread] = result.threads
    expect(thread).toMatchObject({
      id: 'th-whole',
      status: 'resolved',
      anchor: { kind: 'text', quote: { exact: 'migration' }, start: 4, end: 13 },
    })
    expect(thread?.messages.map((m) => [m.body, m.author])).toEqual([
      ['first remark', 'agent:reviewer'],
      ['second remark', 'agent:author'],
    ])
    expect(thread?.messages.every((m) => typeof m.createdAt === 'string')).toBe(true)
  })
})

type Anchor = AnnotationAnchor

describe('wb_thread_edit refuses an anchor that names nothing on the document', () => {
  async function open(store: FakeDocumentStore, anchor: Anchor) {
    return createThreadEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'thread.add', anchor, body: 'about this' }],
    })
  }

  test.each<[string, Anchor, RegExp]>([
    ['a node', { kind: 'spatial', nodeId: 'nope', x: 0, y: 0 }, /node "nope"/],
    ['an edge', { kind: 'spatial', edgeId: 'nope', x: 0, y: 0 }, /edge "nope"/],
    [
      'one of a node set',
      { kind: 'spatial', nodeIds: ['a', 'nope'], x: 0, y: 0, width: 10, height: 10 },
      /node "nope"/,
    ],
    [
      'a text node for a passage',
      { kind: 'text', nodeId: 'nope', quote: { exact: 'Alpha' }, start: 0, end: 5 },
      /node "nope"/,
    ],
    [
      'a passage in a node that carries no text',
      { kind: 'text', nodeId: 'f', quote: { exact: 'some' }, start: 0, end: 4 },
      /node "f" is not a text node/,
    ],
    [
      'a passage absent from its node',
      { kind: 'text', nodeId: 'a', quote: { exact: 'zzz' }, start: 0, end: 3 },
      /"zzz"/,
    ],
    [
      'a passage with no node, on a document that has no body',
      { kind: 'text', quote: { exact: 'Alpha' }, start: 0, end: 5 },
      /body/,
    ],
  ])('on a canvas, %s', async (_name, anchor, detail) => {
    const store = new FakeDocumentStore()
    await seedBoard(store)

    await expect(open(store, anchor)).rejects.toThrow(detail)

    const { doc } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(readAnnotations(doc)).toEqual([])
  })

  test.each<[string, Anchor, RegExp]>([
    [
      'a spatial anchor, since a note has no canvas',
      { kind: 'spatial', x: 1, y: 2 },
      /a markdown document has no canvas to anchor to; anchor to a quoted passage/,
    ],
    [
      'a passage absent from the body',
      { kind: 'text', quote: { exact: 'zzz' }, start: 0, end: 3 },
      /"zzz"/,
    ],
    [
      'a passage naming a node, since a note has none',
      { kind: 'text', nodeId: 'a', quote: { exact: 'why' }, start: 0, end: 3 },
      /a markdown document has no node "a"; omit nodeId to quote its body/,
    ],
  ])('on a note, %s', async (_name, anchor, detail) => {
    const store = new FakeDocumentStore()
    await seedMarkdown(store)

    await expect(open(store, anchor)).rejects.toThrow(detail)

    const { doc } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(readAnnotations(doc)).toEqual([])
  })

  test('still opens a thread on every anchor that does name something', async () => {
    const store = new FakeDocumentStore()
    await seedBoard(store)
    const anchors: Anchor[] = [
      { kind: 'spatial', x: 5000, y: 5000 },
      { kind: 'spatial', nodeId: 'a', x: 0, y: 0 },
      { kind: 'spatial', edgeId: 'e1', x: 0, y: 0 },
      { kind: 'spatial', nodeIds: ['a', 'b'], x: 0, y: 0, width: 500, height: 60 },
      { kind: 'text', nodeId: 'a', quote: { exact: 'beta' }, start: 6, end: 10 },
      { kind: 'document' },
    ]

    const result = await createThreadEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: anchors.map((anchor) => ({ op: 'thread.add' as const, anchor, body: 'ok' })),
    })

    expect(result.threads).toHaveLength(anchors.length)
  })
})

describe('wb_thread_edit edge anchors on a canvas with several edges', () => {
  const TWO_EDGES: SpatialCanvas = {
    nodes: BOARD.nodes,
    edges: [
      { id: 'e1', from: { node: 'a' }, to: { node: 'b' } },
      { id: 'e2', from: { node: 'b' }, to: { node: 'a' } },
    ],
  }

  async function seedTwoEdges(store: FakeDocumentStore): Promise<void> {
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, TWO_EDGES)
    })
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  }

  test.each(['e1', 'e2'])('accepts an anchor on edge %s, whichever edge it is', async (edgeId) => {
    const store = new FakeDocumentStore()
    await seedTwoEdges(store)

    const result = await createThreadEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [{ op: 'thread.add', anchor: { kind: 'spatial', edgeId, x: 0, y: 0 }, body: edgeId }],
    })

    expect(result.threads).toHaveLength(1)
  })

  test('refuses an anchor on an edge the canvas does not hold, naming it', async () => {
    const store = new FakeDocumentStore()
    await seedTwoEdges(store)

    await expect(
      createThreadEditTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [
          { op: 'thread.add', anchor: { kind: 'spatial', edgeId: 'e3', x: 0, y: 0 }, body: 'x' },
        ],
      }),
    ).rejects.toThrow(/edge "e3" is not on the canvas/)
  })
})
