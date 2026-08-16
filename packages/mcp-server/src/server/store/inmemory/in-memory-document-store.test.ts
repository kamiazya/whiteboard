import type { DocRef } from '@kamiazya/whiteboard-ports'
import { describe, expect, it } from 'vitest'
import { InMemoryDocumentStore } from './in-memory-document-store.js'

function canvasRef(documentId: string): DocRef {
  return { kind: 'canvas', documentId }
}

describe('InMemoryDocumentStore', () => {
  it('returns null from loadSnapshot and readFrontier before any save', async () => {
    const store = new InMemoryDocumentStore()
    const docRef = canvasRef('canvas-a')

    expect(await store.loadSnapshot({ docRef })).toBeNull()
    expect(await store.readFrontier({ docRef })).toBeNull()
  })

  it('round-trips a saved snapshot byte-identically', async () => {
    const store = new InMemoryDocumentStore()
    const docRef = canvasRef('canvas-a')
    const bytes = new Uint8Array([1, 2, 3])
    const frontier = new Uint8Array([9, 9])

    await store.saveSnapshot({
      docRef,
      manifest: { chunkCount: 1, totalBytes: 3, maxChunkBytes: 1024 },
      chunks: [{ index: 0, of: 1, bytes }],
      frontier,
    })

    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded).not.toBeNull()
    expect(loaded?.chunks).toHaveLength(1)
    expect(loaded?.chunks[0]?.bytes).toEqual(bytes)
    expect(loaded?.frontier).toEqual(frontier)
    expect(await store.readFrontier({ docRef })).toEqual({ frontier })
  })

  it('appends deltas and reflects the latest frontier', async () => {
    const store = new InMemoryDocumentStore()
    const docRef = canvasRef('canvas-b')
    const updateA = new Uint8Array([1])
    const updateB = new Uint8Array([2])

    await store.appendDeltas({
      docRef,
      deltaBatch: { updates: [updateA], newFrontier: new Uint8Array([1]) },
    })
    const result = await store.appendDeltas({
      docRef,
      deltaBatch: { updates: [updateB], newFrontier: new Uint8Array([2]) },
    })

    expect(result).toEqual({ frontier: new Uint8Array([2]) })
    expect(await store.readFrontier({ docRef })).toEqual({ frontier: new Uint8Array([2]) })

    const loaded = await store.loadDeltas({ docRef, sinceFrontier: new Uint8Array() })
    expect(loaded.updates).toEqual([updateA, updateB])
  })

  it('ignores a non-empty sinceFrontier and returns the full accumulated delta log', async () => {
    const store = new InMemoryDocumentStore()
    const docRef = canvasRef('canvas-b')
    const updateA = new Uint8Array([1])
    const updateB = new Uint8Array([2])

    await store.appendDeltas({
      docRef,
      deltaBatch: { updates: [updateA], newFrontier: new Uint8Array([1]) },
    })
    await store.appendDeltas({
      docRef,
      deltaBatch: { updates: [updateB], newFrontier: new Uint8Array([2]) },
    })

    const loaded = await store.loadDeltas({
      docRef,
      sinceFrontier: new Uint8Array([1]),
    })
    expect(loaded.updates).toEqual([updateA, updateB])
  })

  it('isolates deltas between distinct docRefs', async () => {
    const store = new InMemoryDocumentStore()
    const refA = canvasRef('canvas-a')
    const refB = canvasRef('canvas-b')

    await store.appendDeltas({
      docRef: refA,
      deltaBatch: { updates: [new Uint8Array([1])], newFrontier: new Uint8Array([1]) },
    })

    const loadedB = await store.loadDeltas({ docRef: refB, sinceFrontier: new Uint8Array() })
    expect(loadedB.updates).toEqual([])
    expect(await store.readFrontier({ docRef: refB })).toBeNull()
  })

  it('isolates docRef kind (canvas vs workspace-tree with the same id shape)', async () => {
    const store = new InMemoryDocumentStore()
    const canvasDocRef: DocRef = { kind: 'canvas', documentId: 'shared-id' }
    const workspaceDocRef: DocRef = { kind: 'workspace-tree', workspaceId: 'shared-id' }

    await store.appendDeltas({
      docRef: canvasDocRef,
      deltaBatch: { updates: [new Uint8Array([7])], newFrontier: new Uint8Array([7]) },
    })

    expect(await store.readFrontier({ docRef: workspaceDocRef })).toBeNull()
  })

  it('does not let a caller mutate stored bytes after the fact', async () => {
    const store = new InMemoryDocumentStore()
    const docRef = canvasRef('canvas-c')
    const bytes = new Uint8Array([1, 2, 3])

    await store.saveSnapshot({
      docRef,
      manifest: { chunkCount: 1, totalBytes: 3, maxChunkBytes: 1024 },
      chunks: [{ index: 0, of: 1, bytes }],
      frontier: new Uint8Array([1]),
    })
    bytes[0] = 255

    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded?.chunks[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]))
  })
})
