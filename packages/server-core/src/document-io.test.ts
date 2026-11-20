import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, onTestFinished, test } from 'vitest'
import { withDocument, withNewDocument } from './document-session.js'
import { canvasOf } from './document-session-reads.js'
import { setLogSink } from './log.js'
import type { ServerDeps } from './server-deps.js'
import { FakeDocumentStore, seedDoc } from './test-utils/fake-document-store.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'
import { unusedDocumentIndex } from './test-utils/unused-document-index.js'

const WORKSPACE_ID = '01ZVM89A4A1V9FS03Z9J64KEK1'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

const canvasDeps = (documentStore: FakeDocumentStore) =>
  makeTestDeps({ documentStore, documentIndex: unusedDocumentIndex() })

/** A save of an empty document, which is what announces the write. */
const saveEmptyDocument = (deps: ServerDeps) =>
  withNewDocument(deps, WORKSPACE_ID, DOCUMENT_ID, (session) => session.save())

describe('document-io', () => {
  test('a patched canvas saved and reloaded keeps the nodes the patch did not touch', async () => {
    const documentStore = new FakeDocumentStore()
    const deps = canvasDeps(documentStore)
    await seedDoc(documentStore, DOCUMENT_ID, (doc) =>
      writeSpatialCanvas(doc, {
        nodes: [
          textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 50, text: 'hello' }),
          textNode({ id: 'n2', x: 10, y: 10, width: 100, height: 50, text: 'world' }),
        ],
        edges: [],
      }),
    )

    // A patch that touches only n1, handing the FULL node array back.
    await withDocument(deps, WORKSPACE_ID, DOCUMENT_ID, async (session) => {
      const canvas = await canvasOf(session)
      expect(canvas.nodes).toHaveLength(2)
      const patched = {
        nodes: canvas.nodes.map((node) => (node.id === 'n1' ? { ...node, x: 99 } : node)),
        edges: canvas.edges,
      }
      session.write([{ op: 'reconcileSpatialCanvas', args: { prev: canvas, next: patched } }])
      await session.save()
    })

    const reloaded = await withDocument(deps, WORKSPACE_ID, DOCUMENT_ID, canvasOf)
    expect(reloaded.nodes).toHaveLength(2)
    expect(reloaded.nodes.find((node) => node.id === 'n1')?.x).toBe(99)
    expect(reloaded.nodes.find((node) => node.id === 'n2')).toEqual(
      textNode({ id: 'n2', x: 10, y: 10, width: 100, height: 50, text: 'world' }),
    )
  })
})

// The write side of the same gap `documentTeardown` closed on the delete
// side: a composition root has work to do after a document changes that
// server-core cannot name. The daemon's is auto-compaction — its HTTP write
// path fires a saved-listener that schedules one, and this path, which is
// every agent write, reached the store directly and told nobody. An
// agent-driven canvas therefore never compacted its op-log.
describe('documentWritten', () => {
  function observed() {
    const seen: string[] = []
    return {
      seen,
      observer: async ({ documentId }: { documentId: string }) => {
        seen.push(documentId)
      },
    }
  }

  test('a saved snapshot tells the composition root which document changed', async () => {
    const documentStore = new FakeDocumentStore()
    const { seen, observer } = observed()

    await saveEmptyDocument({ ...canvasDeps(documentStore), documentWritten: observer })

    expect(seen).toEqual([DOCUMENT_ID])
  })

  // What an observer needs to take a history checkpoint: the document and the
  // path the index places it at; the state it reads from the keeper.
  test('the observer is handed the document written and the path the index places it at', async () => {
    const documentIndex = new InMemoryDocumentIndex()
    await documentIndex.createWorkspace({ workspaceId: WORKSPACE_ID })
    const entry = await documentIndex.createDocument({
      workspaceId: WORKSPACE_ID,
      path: 'placed/here',
      kind: 'spatial',
    })
    const heard: { documentId: string; keys: string[]; path?: string }[] = []

    await withNewDocument(
      {
        ...makeTestDeps({ documentStore: new FakeDocumentStore(), documentIndex }),
        documentWritten: async (input) => {
          heard.push({
            documentId: input.documentId,
            keys: Object.keys(input).sort(),
            ...(input.path === undefined ? {} : { path: input.path }),
          })
        },
      },
      WORKSPACE_ID,
      entry.documentId,
      (session) => session.save(),
    )

    expect(heard).toEqual([
      {
        documentId: entry.documentId,
        keys: ['documentId', 'path', 'workspaceId'],
        path: 'placed/here',
      },
    ])
  })

  test('an index that cannot place the document still notifies, without a path', async () => {
    const heard: { path?: string }[] = []

    await saveEmptyDocument({
      ...canvasDeps(new FakeDocumentStore()),
      documentWritten: async (input) => {
        heard.push(input.path === undefined ? {} : { path: input.path })
      },
    })

    expect(heard).toEqual([{}])
  })

  test('the bytes are stored before the observer hears about it', async () => {
    const documentStore = new FakeDocumentStore()
    const order: string[] = []
    const documentStoreSpy = new Proxy(documentStore, {
      get(target, key, receiver) {
        if (key === 'saveSnapshot') {
          return async (...args: Parameters<FakeDocumentStore['saveSnapshot']>) => {
            order.push('saved')
            return await target.saveSnapshot(...args)
          }
        }
        return Reflect.get(target, key, receiver)
      },
    })

    await saveEmptyDocument({
      ...canvasDeps(documentStoreSpy as FakeDocumentStore),
      documentWritten: async () => {
        order.push('observed')
      },
    })

    expect(order).toEqual(['saved', 'observed'])
  })

  // Scheduling a background compaction is not part of the write's
  // correctness — the user's bytes are already safe. An observer that
  // throws must not turn a successful write into a failed one, and this
  // pins that rather than leaving it to a comment the next caller may not
  // read.
  test('a throwing observer does not fail a write that already succeeded', async () => {
    const records: { level: string; msg: string; data?: Record<string, unknown> }[] = []
    setLogSink((record) => records.push(record))
    onTestFinished(() => setLogSink(() => {}))
    const documentStore = new FakeDocumentStore()

    await expect(
      saveEmptyDocument({
        ...canvasDeps(documentStore),
        documentWritten: async () => {
          throw new Error('scheduler exploded')
        },
      }),
    ).resolves.toBeUndefined()

    expect(
      await documentStore.loadSnapshot({
        docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
      }),
    ).not.toBeNull()
    // Swallowed for the caller, not for the operator: a scheduler that keeps
    // throwing would otherwise stop compacting with nothing to say so.
    expect(records.find((record) => record.level === 'warning')).toMatchObject({
      data: { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, err: 'scheduler exploded' },
    })
  })
})
