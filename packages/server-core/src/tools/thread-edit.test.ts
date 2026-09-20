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
  writeThreadMessage,
} from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, test } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { loadDocument, saveDocumentSnapshot } from './document-io.js'
import { createThreadEditTool } from './thread-edit.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(store: FakeDocumentStore): ServerDeps {
  return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
}

async function seedMarkdown(store: FakeDocumentStore): Promise<void> {
  await seedDoc(store, DOCUMENT_ID, (doc) => writeDocumentKind(doc, 'markdown'))
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

    expect(result.threads).toEqual([{ id: 'th-batch', status: 'open', messageCount: 2 }])
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
})
