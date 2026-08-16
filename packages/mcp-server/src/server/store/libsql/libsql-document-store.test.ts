import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DocRef } from '@kamiazya/whiteboard-ports'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../db/test-helpers.js'
import { LibsqlDocumentStore } from './libsql-document-store.js'

function canvasRef(documentId: string): DocRef {
  return { kind: 'canvas', documentId }
}

let tempDir: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let store: LibsqlDocumentStore

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-libsql-doc-store-test-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  store = new LibsqlDocumentStore(handle.db)
})

afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

describe('LibsqlDocumentStore', () => {
  it('returns null from loadSnapshot and readFrontier before any save', async () => {
    const docRef = canvasRef('canvas-a')

    expect(await store.loadSnapshot({ docRef })).toBeNull()
    expect(await store.readFrontier({ docRef })).toBeNull()
  })

  it('round-trips a saved snapshot byte-identically, including multi-chunk out of insertion order', async () => {
    const docRef = canvasRef('canvas-a')
    const chunkB = new Uint8Array([4, 5, 6])
    const chunkA = new Uint8Array([1, 2, 3])
    const frontier = new Uint8Array([9, 9])

    await store.saveSnapshot({
      docRef,
      manifest: { chunkCount: 2, totalBytes: 6, maxChunkBytes: 1024 },
      // Insert out of index order to prove loadSnapshot re-sorts.
      chunks: [
        { index: 1, of: 2, bytes: chunkB },
        { index: 0, of: 2, bytes: chunkA },
      ],
      frontier,
    })

    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded).not.toBeNull()
    expect(loaded?.manifest).toEqual({ chunkCount: 2, totalBytes: 6, maxChunkBytes: 1024 })
    expect(loaded?.chunks.map((c) => c.bytes)).toEqual([chunkA, chunkB])
    expect(loaded?.chunks.map((c) => c.index)).toEqual([0, 1])
    expect(loaded?.frontier).toEqual(frontier)
    expect(await store.readFrontier({ docRef })).toEqual({ frontier })
  })

  it('saves and loads back a valid empty snapshot, distinct from never-saved', async () => {
    const docRef = canvasRef('canvas-empty')

    await store.saveSnapshot({
      docRef,
      manifest: { chunkCount: 0, totalBytes: 0, maxChunkBytes: 1024 },
      chunks: [],
      frontier: new Uint8Array(),
    })

    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded).not.toBeNull()
    expect(loaded?.chunks).toEqual([])
    expect(loaded?.manifest.chunkCount).toBe(0)
  })

  it('replacing a snapshot with fewer chunks leaves no orphaned chunk rows', async () => {
    const docRef = canvasRef('canvas-shrink')

    await store.saveSnapshot({
      docRef,
      manifest: { chunkCount: 3, totalBytes: 3, maxChunkBytes: 1024 },
      chunks: [
        { index: 0, of: 3, bytes: new Uint8Array([1]) },
        { index: 1, of: 3, bytes: new Uint8Array([2]) },
        { index: 2, of: 3, bytes: new Uint8Array([3]) },
      ],
      frontier: new Uint8Array([1]),
    })

    await store.saveSnapshot({
      docRef,
      manifest: { chunkCount: 1, totalBytes: 1, maxChunkBytes: 1024 },
      chunks: [{ index: 0, of: 1, bytes: new Uint8Array([9]) }],
      frontier: new Uint8Array([2]),
    })

    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded?.chunks).toHaveLength(1)
    expect(loaded?.chunks[0]?.bytes).toEqual(new Uint8Array([9]))

    const rowCount = await handle.db
      .selectFrom('documentSnapshotChunks')
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirst()
    expect(Number(rowCount?.count)).toBe(1)
  })

  // Regression for a parity counterexample the model-based property test
  // found: InMemoryDocumentStore's loadSnapshot reports the doc's *current*
  // frontier (shared with appendDeltas), not the frontier the snapshot was
  // originally saved with. A later appendDeltas call must be visible through
  // a subsequent loadSnapshot's `frontier` field.
  it('loadSnapshot reports the current frontier, not the frontier the snapshot was saved with', async () => {
    const docRef = canvasRef('canvas-frontier-drift')

    await store.saveSnapshot({
      docRef,
      manifest: { chunkCount: 0, totalBytes: 0, maxChunkBytes: 1 },
      chunks: [],
      frontier: new Uint8Array(),
    })
    await store.appendDeltas({
      docRef,
      deltaBatch: { updates: [new Uint8Array()], newFrontier: new Uint8Array([0]) },
    })

    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded?.frontier).toEqual(new Uint8Array([0]))
  })

  it('appendDeltas returns the new frontier and assigns monotonic seq across batches', async () => {
    const docRef = canvasRef('canvas-b')
    const updateA = new Uint8Array([1])
    const updateB = new Uint8Array([2])

    const first = await store.appendDeltas({
      docRef,
      deltaBatch: { updates: [updateA], newFrontier: new Uint8Array([1]) },
    })
    expect(first).toEqual({ frontier: new Uint8Array([1]) })

    const second = await store.appendDeltas({
      docRef,
      deltaBatch: { updates: [updateB], newFrontier: new Uint8Array([2]) },
    })
    expect(second).toEqual({ frontier: new Uint8Array([2]) })

    expect(await store.readFrontier({ docRef })).toEqual({ frontier: new Uint8Array([2]) })

    const loaded = await store.loadDeltas({ docRef, sinceFrontier: new Uint8Array() })
    expect(loaded.updates).toEqual([updateA, updateB])
    expect(loaded.frontier).toEqual(new Uint8Array([2]))
  })

  it('isolates snapshots/deltas/frontier between distinct docRefs, including canvas vs workspace-tree', async () => {
    const canvasA = canvasRef('shared-id')
    const canvasB = canvasRef('canvas-other')
    const workspaceRef: DocRef = { kind: 'workspace-tree', workspaceId: 'shared-id' }

    await store.appendDeltas({
      docRef: canvasA,
      deltaBatch: { updates: [new Uint8Array([7])], newFrontier: new Uint8Array([7]) },
    })

    expect(await store.readFrontier({ docRef: canvasB })).toBeNull()
    expect(await store.readFrontier({ docRef: workspaceRef })).toBeNull()
    const workspaceDeltas = await store.loadDeltas({
      docRef: workspaceRef,
      sinceFrontier: new Uint8Array(),
    })
    expect(workspaceDeltas.updates).toEqual([])
  })

  it('rolls back saveSnapshot atomically on a mid-write failure, leaving the prior snapshot intact', async () => {
    const docRef = canvasRef('canvas-atomic')

    await store.saveSnapshot({
      docRef,
      manifest: { chunkCount: 1, totalBytes: 1, maxChunkBytes: 1024 },
      chunks: [{ index: 0, of: 1, bytes: new Uint8Array([1]) }],
      frontier: new Uint8Array([1]),
    })

    // Two chunks sharing the same index violate the (docKey, chunkIndex)
    // primary key, so the chunk INSERT throws mid-transaction. The whole
    // transaction (header upsert + chunk delete/insert + frontier upsert)
    // must roll back — the prior snapshot must still load intact.
    await expect(
      store.saveSnapshot({
        docRef,
        manifest: { chunkCount: 2, totalBytes: 2, maxChunkBytes: 1024 },
        chunks: [
          { index: 0, of: 2, bytes: new Uint8Array([9]) },
          { index: 0, of: 2, bytes: new Uint8Array([8]) },
        ],
        frontier: new Uint8Array([2]),
      }),
    ).rejects.toThrow()

    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded?.manifest).toEqual({ chunkCount: 1, totalBytes: 1, maxChunkBytes: 1024 })
    expect(loaded?.chunks.map((c) => c.bytes)).toEqual([new Uint8Array([1])])
    expect(await store.readFrontier({ docRef })).toEqual({ frontier: new Uint8Array([1]) })
  })

  it('a first-ever failed saveSnapshot leaves loadSnapshot returning null (no header-without-chunks)', async () => {
    const docRef = canvasRef('canvas-atomic-first')

    await expect(
      store.saveSnapshot({
        docRef,
        manifest: { chunkCount: 2, totalBytes: 2, maxChunkBytes: 1024 },
        chunks: [
          { index: 0, of: 2, bytes: new Uint8Array([9]) },
          { index: 0, of: 2, bytes: new Uint8Array([8]) },
        ],
        frontier: new Uint8Array([2]),
      }),
    ).rejects.toThrow()

    expect(await store.loadSnapshot({ docRef })).toBeNull()
    expect(await store.readFrontier({ docRef })).toBeNull()
  })

  it('returns independent buffer copies (mutating a returned value does not corrupt subsequent reads)', async () => {
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

    const loadedAgain = await store.loadSnapshot({ docRef })
    if (loadedAgain?.chunks[0]) {
      loadedAgain.chunks[0].bytes[0] = 254
    }
    const loadedOnceMore = await store.loadSnapshot({ docRef })
    expect(loadedOnceMore?.chunks[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]))
  })
})
