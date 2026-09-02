import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { unusedDocumentIndex } from '../test-utils/unused-document-index.js'
import { loadDocument, SnapshotNotFoundError, saveDocumentBodySnapshot } from './document-io.js'

const WORKSPACE_ID = 'ws-1'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

const canvasDeps = (documentStore: FakeDocumentStore) =>
  makeTestDeps({ documentStore, documentIndex: unusedDocumentIndex() })

describe('document-io', () => {
  test('loadDocument throws SnapshotNotFoundError when no snapshot exists', async () => {
    const documentStore = new FakeDocumentStore()
    await expect(
      loadDocument(canvasDeps(documentStore), WORKSPACE_ID, DOCUMENT_ID),
    ).rejects.toThrow(SnapshotNotFoundError)
  })

  // Moved here with the loader: this used to live beside a second,
  // byte-identical `loadSpatialCanvas`, which is what made two classes for
  // one condition look reasonable.
  test('loadDocument returns the doc and the decoded canvas for an existing snapshot', async () => {
    const documentStore = new FakeDocumentStore()
    await seedDoc(documentStore, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
        edges: [],
      })
    })

    const { doc, canvas } = await loadDocument(canvasDeps(documentStore), WORKSPACE_ID, DOCUMENT_ID)

    expect(doc).toBeInstanceOf(LoroDoc)
    expect(canvas.nodes).toEqual([
      { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' },
    ])
  })

  test('save then load round trip preserves nodes untouched by the patch', async () => {
    const documentStore = new FakeDocumentStore()
    const deps = canvasDeps(documentStore)

    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' },
        { id: 'n2', type: 'text', x: 10, y: 10, width: 100, height: 50, text: 'world' },
      ],
      edges: [],
    }

    // Seed the store directly (bypassing the tool under test).
    const seedDoc = new LoroDoc()
    writeSpatialCanvas(seedDoc, canvas)
    const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
    await documentStore.saveSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
      manifest,
      chunks,
      frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
    })

    const loaded = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(loaded.canvas.nodes).toHaveLength(2)

    // Simulate a patch that only touches n1, passing the FULL node array back.
    const patched: SpatialCanvas = {
      nodes: loaded.canvas.nodes.map((node) => (node.id === 'n1' ? { ...node, x: 99 } : node)),
      edges: loaded.canvas.edges,
    }
    await saveDocumentBodySnapshot(deps, WORKSPACE_ID, DOCUMENT_ID, loaded.doc, patched)

    const reloaded = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(reloaded.canvas.nodes).toHaveLength(2)
    const n2 = reloaded.canvas.nodes.find((node) => node.id === 'n2')
    expect(n2).toEqual(canvas.nodes[1])
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

    await saveDocumentBodySnapshot(
      { ...canvasDeps(documentStore), documentWritten: observer },
      WORKSPACE_ID,
      DOCUMENT_ID,
      new LoroDoc(),
      { nodes: [], edges: [] } satisfies SpatialCanvas,
    )

    expect(seen).toEqual([DOCUMENT_ID])
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

    await saveDocumentBodySnapshot(
      {
        ...canvasDeps(documentStoreSpy as FakeDocumentStore),
        documentWritten: async () => {
          order.push('observed')
        },
      },
      WORKSPACE_ID,
      DOCUMENT_ID,
      new LoroDoc(),
      { nodes: [], edges: [] } satisfies SpatialCanvas,
    )

    expect(order).toEqual(['saved', 'observed'])
  })

  // Scheduling a background compaction is not part of the write's
  // correctness — the user's bytes are already safe. An observer that
  // throws must not turn a successful write into a failed one, and this
  // pins that rather than leaving it to a comment the next caller may not
  // read.
  test('a throwing observer does not fail a write that already succeeded', async () => {
    const documentStore = new FakeDocumentStore()

    await expect(
      saveDocumentBodySnapshot(
        {
          ...canvasDeps(documentStore),
          documentWritten: async () => {
            throw new Error('scheduler exploded')
          },
        },
        WORKSPACE_ID,
        DOCUMENT_ID,
        new LoroDoc(),
        { nodes: [], edges: [] } satisfies SpatialCanvas,
      ),
    ).resolves.toBeUndefined()

    expect(
      await documentStore.loadSnapshot({
        docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
      }),
    ).not.toBeNull()
  })
})
