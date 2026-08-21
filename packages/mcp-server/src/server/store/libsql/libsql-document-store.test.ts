import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DocRef } from '@kamiazya/whiteboard-ports'
import { describeDocumentStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../db/test-helpers.js'
import { LibsqlDocumentStore } from './libsql-document-store.js'

function canvasRef(documentId: string): DocRef {
  return { kind: 'document', documentId }
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
  // The shared guarantees. What stays written out below is what only THIS
  // store can be asked: transactional rollback, and the partial-write states
  // a database can reach that a Map cannot.
  describeDocumentStoreConformance(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whiteboard-libsql-doc-store-conformance-'))
    const isolated = await createIsolatedDb({ dataDir: dir })
    const conformanceStore = new LibsqlDocumentStore(isolated.db)
    return {
      store: conformanceStore,
      writeUnreadableRecord: (docRef) => conformanceStore.writeUnreadableRecord(docRef),
      dispose: async () => {
        await isolated.dispose()
        await rm(dir, { recursive: true, force: true })
      },
    }
  })

  // Regression for a parity counterexample the model-based property test
  // found: InMemoryDocumentStore's loadSnapshot reports the doc's *current*
  // frontier (shared with appendDeltas), not the frontier the snapshot was
  // originally saved with. A later appendDeltas call must be visible through
  // a subsequent loadSnapshot's `frontier` field.

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
})
