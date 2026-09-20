/**
 * `SealedDocumentStore` over a real IndexedDB `IdbDocumentStore` and real
 * WebCrypto: the port's own conformance suite passes through it unchanged,
 * and — the increment's actual claim — a saved replica's content is never
 * readable as plaintext straight out of the database.
 */
import type { DocRef, DocumentStore, SnapshotManifest } from '@kamiazya/whiteboard-ports'
import { chunkSnapshot, docRefKey, StoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import { describeDocumentStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { SYNC_DOCUMENTS_STORE, SYNC_SNAPSHOT_CHUNKS_STORE } from './browser-idb.js'
import { IdbDocumentStore } from './idb-document-store.js'
import {
  decodeEnvelope,
  ENVELOPE_OVERHEAD,
  encodeEnvelope,
  type ReplicaKeyProvider,
  ReplicaKeyWithheldError,
  SealedDocumentStore,
} from './sealed-document-store.js'

const DB_NAME = 'whiteboard-sealed-document-store'

async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

function fixedKeyProvider(key: CryptoKey, epoch: number): ReplicaKeyProvider {
  return { keyFor: async () => ({ key, epoch }) }
}

function withheldProvider(): ReplicaKeyProvider {
  return { keyFor: async () => 'withheld' }
}

function countingProvider(base: ReplicaKeyProvider): {
  provider: ReplicaKeyProvider
  calls: () => number
} {
  let calls = 0
  return {
    provider: {
      keyFor: async (documentId) => {
        calls += 1
        return base.keyFor(documentId)
      },
    },
    calls: () => calls,
  }
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length))
}

describe('SealedDocumentStore', () => {
  describeDocumentStoreConformance(async () => {
    await clearNamedDb(DB_NAME)
    const inner = new IdbDocumentStore(DB_NAME)
    const key = await generateKey()
    const store = new SealedDocumentStore(inner, fixedKeyProvider(key, 0))
    return {
      store,
      dispose: () => clearNamedDb(DB_NAME),
      writeUnreadableRecord: (docRef) => inner.writeUnreadableRecord(docRef),
    }
  })
})

describe('SealedDocumentStore over a real IndexedDB', () => {
  const docRef: DocRef = {
    kind: 'document',
    workspaceId: 'sealed-ws',
    documentId: '01JD0SEALEDSTORE0000000001',
  }

  function openRaw(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  function getAll(db: IDBDatabase, store: string): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const req = db.transaction([store], 'readonly').objectStore(store).getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  function get(db: IDBDatabase, store: string, key: IDBValidKey): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = db.transaction([store], 'readonly').objectStore(store).get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  function put(db: IDBDatabase, store: string, value: unknown, key: IDBValidKey): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([store], 'readwrite')
      tx.objectStore(store).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('aborted'))
    })
  }

  function collectUint8Arrays(value: unknown, out: Uint8Array[] = []): Uint8Array[] {
    if (Object.prototype.toString.call(value) === '[object Uint8Array]') {
      out.push(value as Uint8Array)
    } else if (Array.isArray(value)) {
      for (const item of value) collectUint8Arrays(item, out)
    } else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>))
        collectUint8Arrays(item, out)
    }
    return out
  }

  function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
    if (needle.length === 0 || needle.length > haystack.length) return false
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer
      }
      return true
    }
    return false
  }

  beforeEach(() => clearNamedDb(DB_NAME))
  afterEach(() => clearNamedDb(DB_NAME))

  it('round-trips a saveSnapshot byte-identically, chunks and manifest included', async () => {
    const key = await generateKey()
    const store = new SealedDocumentStore(new IdbDocumentStore(DB_NAME), fixedKeyProvider(key, 0))
    const bytes = randomBytes(4096)
    const { manifest, chunks } = chunkSnapshot(bytes, 1024)
    const frontier = randomBytes(4)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier })

    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded?.manifest).toEqual(manifest)
    expect(loaded?.chunks.map((chunk) => [chunk.index, chunk.of, [...chunk.bytes]])).toEqual(
      chunks.map((chunk) => [chunk.index, chunk.of, [...chunk.bytes]]),
    )
    expect([...(loaded?.frontier ?? [])]).toEqual([...frontier])
  })

  it('round-trips appendDeltas byte-identically', async () => {
    const key = await generateKey()
    const store = new SealedDocumentStore(new IdbDocumentStore(DB_NAME), fixedKeyProvider(key, 0))
    const update = randomBytes(80)
    const newFrontier = randomBytes(3)
    await store.appendDeltas({ docRef, deltaBatch: { updates: [update], newFrontier } })

    const loaded = await store.loadDeltas({ docRef, afterSeq: null })
    expect(loaded.updates.map((u) => [...u])).toEqual([[...update]])
    expect([...loaded.frontier]).toEqual([...newFrontier])
  })

  it('round-trips saveCompactedSnapshot byte-identically', async () => {
    const key = await generateKey()
    const inner = new IdbDocumentStore(DB_NAME)
    const store = new SealedDocumentStore(inner, fixedKeyProvider(key, 0))
    await store.appendDeltas({
      docRef,
      deltaBatch: { updates: [randomBytes(10)], newFrontier: randomBytes(2) },
    })
    const bytes = randomBytes(512)
    const { manifest, chunks } = chunkSnapshot(bytes, 256)
    const frontier = randomBytes(4)
    const result = await store.saveCompactedSnapshot({
      docRef,
      manifest,
      chunks,
      frontier,
      supersededDeltaCount: 1,
      expectedGeneration: null,
    })
    expect(result.ok).toBe(true)

    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded?.manifest).toEqual(manifest)
    expect(loaded?.chunks.map((chunk) => [...chunk.bytes])).toEqual(
      chunks.map((chunk) => [...chunk.bytes]),
    )
  })

  fcTest.prop(
    [
      fc.uint8Array({ minLength: 1, maxLength: 3000 }),
      fc.integer({ min: 1, max: 64 }),
      fc.array(fc.uint8Array({ minLength: 1, maxLength: 200 }), { minLength: 1, maxLength: 5 }),
    ],
    withDefaults({ numRuns: 15 }),
  )(
    'seals and opens a random snapshot+deltas pair losslessly over a real IdbDocumentStore',
    async (snapshotBytes, maxChunkBytes, deltas) => {
      await clearNamedDb(DB_NAME)
      const key = await generateKey()
      const store = new SealedDocumentStore(new IdbDocumentStore(DB_NAME), fixedKeyProvider(key, 0))
      const ref: DocRef = {
        kind: 'document',
        workspaceId: 'sealed-ws',
        documentId: '01JD0PROPERTY000000000001',
      }
      const narrowed = new Uint8Array(snapshotBytes) as Uint8Array<ArrayBuffer>
      const { manifest, chunks } = chunkSnapshot(narrowed, maxChunkBytes)
      const frontier = new Uint8Array([1])
      await store.saveSnapshot({ docRef: ref, manifest, chunks, frontier })
      const loadedSnapshot = await store.loadSnapshot({ docRef: ref })
      expect(loadedSnapshot?.manifest).toEqual(manifest)
      expect(loadedSnapshot?.chunks.map((c) => [...c.bytes])).toEqual(
        chunks.map((c) => [...c.bytes]),
      )

      const reportedManifest = await store.readSnapshotManifest({ docRef: ref })
      expect(reportedManifest?.manifest).toEqual(manifest)

      await store.appendDeltas({
        docRef: ref,
        deltaBatch: {
          updates: deltas as Uint8Array<ArrayBuffer>[],
          newFrontier: new Uint8Array([2]),
        },
      })
      const loadedDeltas = await store.loadDeltas({ docRef: ref, afterSeq: null })
      expect(loadedDeltas.updates.map((u) => [...u])).toEqual(deltas.map((d) => [...d]))
      await clearNamedDb(DB_NAME)
    },
  )

  it('keeps the plaintext out of every object store, and marks every sealed value with its version byte', async () => {
    const key = await generateKey()
    const store = new SealedDocumentStore(new IdbDocumentStore(DB_NAME), fixedKeyProvider(key, 0))
    const snapshotPlaintext = randomBytes(64)
    const deltaPlaintext = randomBytes(48)
    // One chunk holding the whole plaintext contiguously — a smaller
    // maxChunkBytes would split it across chunks, and a chunk narrower than
    // the needle could never contain it whether sealed or not, which would
    // make the assertion pass for the wrong reason.
    const { manifest, chunks } = chunkSnapshot(snapshotPlaintext, snapshotPlaintext.byteLength)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: randomBytes(4) })
    await store.appendDeltas({
      docRef,
      deltaBatch: { updates: [deltaPlaintext], newFrontier: randomBytes(4) },
    })

    const db = await openRaw()
    const everyByteArray: Uint8Array[] = []
    for (const storeName of Array.from(db.objectStoreNames)) {
      const records = await getAll(db, storeName)
      for (const record of records) collectUint8Arrays(record, everyByteArray)
    }
    db.close()

    expect(everyByteArray.length).toBeGreaterThan(0)
    for (const bytes of everyByteArray) {
      expect(containsBytes(bytes, snapshotPlaintext)).toBe(false)
      expect(containsBytes(bytes, deltaPlaintext)).toBe(false)
    }
    const sealed = everyByteArray.filter((bytes) => bytes.byteLength >= ENVELOPE_OVERHEAD)
    expect(sealed.length).toBeGreaterThan(0)
    for (const bytes of sealed) expect(bytes[0]).toBe(0x01)
  })

  it('throws ReplicaKeyWithheldError for a present record, and never asks the provider for an absent one', async () => {
    const key = await generateKey()
    const inner = new IdbDocumentStore(DB_NAME)
    const { manifest, chunks } = chunkSnapshot(randomBytes(64), 32)
    await new SealedDocumentStore(inner, fixedKeyProvider(key, 0)).saveSnapshot({
      docRef,
      manifest,
      chunks,
      frontier: randomBytes(4),
    })
    await new SealedDocumentStore(inner, fixedKeyProvider(key, 0)).appendDeltas({
      docRef,
      deltaBatch: { updates: [randomBytes(20)], newFrontier: randomBytes(4) },
    })

    const { provider: locked, calls } = countingProvider(withheldProvider())
    const store = new SealedDocumentStore(inner, locked)
    await expect(store.loadSnapshot({ docRef })).rejects.toBeInstanceOf(ReplicaKeyWithheldError)
    await expect(store.loadDeltas({ docRef, afterSeq: null })).rejects.toBeInstanceOf(
      ReplicaKeyWithheldError,
    )
    expect(calls()).toBeGreaterThan(0)

    const { provider: neverAsked, calls: absentCalls } = countingProvider(withheldProvider())
    const absentRef: DocRef = {
      kind: 'document',
      workspaceId: 'sealed-ws',
      documentId: '01JD0ABSENT00000000000001',
    }
    const absentStore = new SealedDocumentStore(inner, neverAsked)
    expect(await absentStore.loadSnapshot({ docRef: absentRef })).toBeNull()
    expect((await absentStore.loadDeltas({ docRef: absentRef, afterSeq: null })).updates).toEqual(
      [],
    )
    expect(await absentStore.readSnapshotManifest({ docRef: absentRef })).toBeNull()
    expect(absentCalls()).toBe(0)
  })

  it('saves and reads a snapshot with zero chunks even while the key is withheld', async () => {
    // The bypass `#sealChunks`/`#openManifestArm` document in comments: an
    // empty manifest hides nothing, so it must save and read back without
    // ever asking a withheld provider for a key.
    const inner = new IdbDocumentStore(DB_NAME)
    const store = new SealedDocumentStore(inner, withheldProvider())
    const emptyRef: DocRef = {
      kind: 'document',
      workspaceId: 'sealed-ws',
      documentId: '01JD0EMPTYCHUNKS00000000001',
    }
    const { manifest, chunks } = chunkSnapshot(new Uint8Array(0), 64)
    expect(manifest.chunkCount).toBe(0)
    await store.saveSnapshot({ docRef: emptyRef, manifest, chunks, frontier: randomBytes(4) })

    const loaded = await store.loadSnapshot({ docRef: emptyRef })
    expect(loaded?.manifest).toEqual(manifest)
    expect(loaded?.chunks).toEqual([])

    const reported = await store.readSnapshotManifest({ docRef: emptyRef })
    expect(reported?.manifest).toEqual(manifest)
  })

  it('readSnapshotManifest throws ReplicaKeyWithheldError for a present, non-empty record while the key is withheld', async () => {
    const key = await generateKey()
    const inner = new IdbDocumentStore(DB_NAME)
    const { manifest, chunks } = chunkSnapshot(randomBytes(64), 32)
    await new SealedDocumentStore(inner, fixedKeyProvider(key, 0)).saveSnapshot({
      docRef,
      manifest,
      chunks,
      frontier: randomBytes(4),
    })

    const locked = new SealedDocumentStore(inner, withheldProvider())
    await expect(locked.readSnapshotManifest({ docRef })).rejects.toBeInstanceOf(
      ReplicaKeyWithheldError,
    )
  })

  it('refuses a tampered chunk and a tampered delta as unreadable, not withheld', async () => {
    const key = await generateKey()
    const inner = new IdbDocumentStore(DB_NAME)
    const store = new SealedDocumentStore(inner, fixedKeyProvider(key, 0))
    const { manifest, chunks } = chunkSnapshot(randomBytes(64), 32)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: randomBytes(4) })
    await store.appendDeltas({
      docRef,
      deltaBatch: { updates: [randomBytes(20)], newFrontier: randomBytes(4) },
    })

    const key0 = [docRefKey(docRef), 0]
    const dbForChunk = await openRaw()
    const chunkRecord = (await get(dbForChunk, SYNC_SNAPSHOT_CHUNKS_STORE, key0)) as {
      bytes: Uint8Array
    }
    const tamperedChunkBytes = new Uint8Array(chunkRecord.bytes)
    tamperedChunkBytes[tamperedChunkBytes.length - 1] ^= 0xff
    await put(
      dbForChunk,
      SYNC_SNAPSHOT_CHUNKS_STORE,
      { ...chunkRecord, bytes: tamperedChunkBytes },
      key0,
    )
    dbForChunk.close()

    await expect(store.loadSnapshot({ docRef })).rejects.toThrow(
      /unreadable|does not decode|failed to open/i,
    )
    await expect(store.loadSnapshot({ docRef })).rejects.not.toBeInstanceOf(ReplicaKeyWithheldError)

    // Restore the chunk on a fresh connection (the tamper assertions above
    // closed the previous one), then tamper the delta log instead.
    const dbForRestore = await openRaw()
    await put(dbForRestore, SYNC_SNAPSHOT_CHUNKS_STORE, chunkRecord, key0)
    dbForRestore.close()

    const dbForDelta = await openRaw()
    const syncRecord = (await get(dbForDelta, SYNC_DOCUMENTS_STORE, docRefKey(docRef))) as {
      deltas: Uint8Array[]
    }
    const tamperedDeltas = syncRecord.deltas.map((delta, index) => {
      if (index !== 0) return delta
      const copy = new Uint8Array(delta)
      copy[copy.length - 1] ^= 0xff
      return copy
    })
    await put(
      dbForDelta,
      SYNC_DOCUMENTS_STORE,
      { ...syncRecord, deltas: tamperedDeltas },
      docRefKey(docRef),
    )
    dbForDelta.close()

    await expect(store.loadDeltas({ docRef, afterSeq: null })).rejects.toThrow(
      /unreadable|does not decode|failed to open/i,
    )
    await expect(store.loadDeltas({ docRef, afterSeq: null })).rejects.not.toBeInstanceOf(
      ReplicaKeyWithheldError,
    )
  })

  it('refuses a chunk and a delta that do not decode as a sealed envelope at all', async () => {
    const key = await generateKey()
    const inner = new IdbDocumentStore(DB_NAME)
    const store = new SealedDocumentStore(inner, fixedKeyProvider(key, 0))
    const { manifest, chunks } = chunkSnapshot(randomBytes(64), 32)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: randomBytes(4) })
    await store.appendDeltas({
      docRef,
      deltaBatch: { updates: [randomBytes(20)], newFrontier: randomBytes(4) },
    })

    // An unknown version byte, same length as the real record: decodeEnvelope
    // itself throws before openBytes is ever reached, exercising #open's
    // FIRST catch (decode failure) rather than its second (AEAD failure) —
    // and the length stays byte-identical to the manifest the inner store
    // cross-checks it against, so THAT check does not fire first instead.
    const key0 = [docRefKey(docRef), 0]
    const dbForChunk = await openRaw()
    const chunkRecord = (await get(dbForChunk, SYNC_SNAPSHOT_CHUNKS_STORE, key0)) as {
      bytes: Uint8Array
    }
    const badVersionChunkBytes = new Uint8Array(chunkRecord.bytes)
    badVersionChunkBytes[0] = 0x02
    await put(
      dbForChunk,
      SYNC_SNAPSHOT_CHUNKS_STORE,
      { ...chunkRecord, bytes: badVersionChunkBytes },
      key0,
    )
    dbForChunk.close()

    await expect(store.loadSnapshot({ docRef })).rejects.toThrow(/does not decode/i)
    await expect(store.loadSnapshot({ docRef })).rejects.toBeInstanceOf(
      StoredDocumentUnreadableError,
    )

    const dbForDelta = await openRaw()
    const syncRecord = (await get(dbForDelta, SYNC_DOCUMENTS_STORE, docRefKey(docRef))) as {
      deltas: Uint8Array[]
    }
    const badVersionDeltas = syncRecord.deltas.map((delta, index) => {
      if (index !== 0) return delta
      const copy = new Uint8Array(delta)
      copy[0] = 0x02
      return copy
    })
    await put(
      dbForDelta,
      SYNC_DOCUMENTS_STORE,
      { ...syncRecord, deltas: badVersionDeltas },
      docRefKey(docRef),
    )
    dbForDelta.close()

    await expect(store.loadDeltas({ docRef, afterSeq: null })).rejects.toThrow(/does not decode/i)
    await expect(store.loadDeltas({ docRef, afterSeq: null })).rejects.toBeInstanceOf(
      StoredDocumentUnreadableError,
    )
  })

  it('refuses to open ciphertext sealed under a different epoch', async () => {
    const key0 = await generateKey()
    const key1 = await generateKey()
    const inner = new IdbDocumentStore(DB_NAME)
    const { manifest, chunks } = chunkSnapshot(randomBytes(64), 32)
    await new SealedDocumentStore(inner, fixedKeyProvider(key0, 0)).saveSnapshot({
      docRef,
      manifest,
      chunks,
      frontier: randomBytes(4),
    })

    const bumped = new SealedDocumentStore(inner, fixedKeyProvider(key1, 1))
    await expect(bumped.loadSnapshot({ docRef })).rejects.toThrow(/unreadable|failed to open/i)
  })

  it('reports the caller-facing manifest while the inner store holds the ciphertext-sized one', async () => {
    const key = await generateKey()
    const inner = new IdbDocumentStore(DB_NAME)
    const store = new SealedDocumentStore(inner, fixedKeyProvider(key, 0))
    const { manifest, chunks } = chunkSnapshot(randomBytes(200), 64)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: randomBytes(4) })

    const innerManifest = await inner.readSnapshotManifest({ docRef })
    expect(innerManifest?.manifest).toEqual({
      chunkCount: manifest.chunkCount,
      totalBytes: manifest.totalBytes + ENVELOPE_OVERHEAD * manifest.chunkCount,
      maxChunkBytes: manifest.maxChunkBytes + ENVELOPE_OVERHEAD,
    })

    const outerManifest = await store.readSnapshotManifest({ docRef })
    expect(outerManifest?.manifest).toEqual(manifest)
    expect(outerManifest?.manifest).toEqual((await store.loadSnapshot({ docRef }))?.manifest)
  })

  // "the plaintext arm": a browser-kept workspace, or any document ref.
  describe('the plaintext arm', () => {
    const plaintextRef: DocRef = {
      kind: 'workspace-tree',
      workspaceId: '01JD0PLAINTEXT000000000001',
    }

    it('round-trips byte-identically to a bare IdbDocumentStore', async () => {
      const bytes = randomBytes(300)
      const { manifest, chunks } = chunkSnapshot(bytes, 128)
      const frontier = randomBytes(4)
      const delta = randomBytes(10)
      const deltaFrontier = randomBytes(4)

      const sealedInner = new IdbDocumentStore(DB_NAME)
      const sealed = new SealedDocumentStore(sealedInner, plaintextProvider())
      await sealed.saveSnapshot({ docRef: plaintextRef, manifest, chunks, frontier })
      await sealed.appendDeltas({
        docRef: plaintextRef,
        deltaBatch: { updates: [delta], newFrontier: deltaFrontier },
      })

      const BARE_DB = `${DB_NAME}-bare`
      await clearNamedDb(BARE_DB)
      const bare = new IdbDocumentStore(BARE_DB)
      await bare.saveSnapshot({ docRef: plaintextRef, manifest, chunks, frontier })
      await bare.appendDeltas({
        docRef: plaintextRef,
        deltaBatch: { updates: [delta], newFrontier: deltaFrontier },
      })

      const sealedDb = await openRaw()
      const bareDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(BARE_DB)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const sealedSync = await getAll(sealedDb, SYNC_DOCUMENTS_STORE)
      const bareSync = await getAll(bareDb, SYNC_DOCUMENTS_STORE)
      expect(sealedSync).toEqual(bareSync)
      const sealedChunks = await getAll(sealedDb, SYNC_SNAPSHOT_CHUNKS_STORE)
      const bareChunks = await getAll(bareDb, SYNC_SNAPSHOT_CHUNKS_STORE)
      expect(sealedChunks).toEqual(bareChunks)
      sealedDb.close()
      bareDb.close()
      await clearNamedDb(BARE_DB)

      const loaded = await sealed.loadSnapshot({ docRef: plaintextRef })
      expect(loaded?.manifest).toEqual(manifest)
      expect(loaded?.chunks.map((c) => [...c.bytes])).toEqual(chunks.map((c) => [...c.bytes]))
    })

    it('readSnapshotManifest answers the inner manifest unchanged', async () => {
      const bytes = randomBytes(50)
      const { manifest, chunks } = chunkSnapshot(bytes, 50)
      const store = new SealedDocumentStore(new IdbDocumentStore(DB_NAME), plaintextProvider())
      await store.saveSnapshot({ docRef: plaintextRef, manifest, chunks, frontier: randomBytes(4) })
      const reported = await store.readSnapshotManifest({ docRef: plaintextRef })
      expect(reported?.manifest).toEqual(manifest)
    })
  })
})

describe('openManifest refuses a manifest smaller than its own envelope overhead', () => {
  const docRef: DocRef = {
    kind: 'document',
    workspaceId: 'sealed-ws',
    documentId: '01JD0MANIFESTBOUNDARY00001',
  }

  /**
   * Answers a fixed (possibly corrupted) manifest for both manifest-reading
   * methods, and refuses every other call — `openManifest` never reads a
   * chunk or a key, so a test of its own boundary needs neither.
   */
  function manifestOnlyInner(manifest: SnapshotManifest): DocumentStore {
    const unused = (): never => {
      throw new Error('not exercised by this test')
    }
    return {
      loadSnapshot: async () => ({ manifest, chunks: [], frontier: new Uint8Array(0) }),
      readSnapshotManifest: async () => ({ manifest, generation: 0 }),
      saveSnapshot: unused,
      saveCompactedSnapshot: unused,
      appendDeltas: unused,
      loadDeltas: unused,
      readFrontier: async () => null,
      deleteDoc: unused,
    }
  }

  it('refuses totalBytes exactly at chunkCount * ENVELOPE_OVERHEAD (chunkCount > 0)', async () => {
    const key = await generateKey()
    // A real sealed chunk's plaintext is always >= 1 byte, so this exact
    // boundary is unreachable except via a corrupted/tampered record.
    const corrupted: SnapshotManifest = {
      chunkCount: 1,
      totalBytes: ENVELOPE_OVERHEAD,
      maxChunkBytes: ENVELOPE_OVERHEAD + 1,
    }
    const store = new SealedDocumentStore(manifestOnlyInner(corrupted), fixedKeyProvider(key, 0))
    await expect(store.readSnapshotManifest({ docRef })).rejects.toBeInstanceOf(
      StoredDocumentUnreadableError,
    )
    await expect(store.loadSnapshot({ docRef })).rejects.toBeInstanceOf(
      StoredDocumentUnreadableError,
    )
  })

  it('accepts totalBytes one byte past the boundary (a real single-byte-plaintext chunk)', async () => {
    const key = await generateKey()
    const minimalReal: SnapshotManifest = {
      chunkCount: 1,
      totalBytes: ENVELOPE_OVERHEAD + 1,
      maxChunkBytes: ENVELOPE_OVERHEAD + 1,
    }
    const store = new SealedDocumentStore(manifestOnlyInner(minimalReal), fixedKeyProvider(key, 0))
    const opened = await store.readSnapshotManifest({ docRef })
    expect(opened?.manifest).toEqual({ chunkCount: 1, totalBytes: 1, maxChunkBytes: 1 })
  })

  it('refuses totalBytes strictly below chunkCount * ENVELOPE_OVERHEAD', async () => {
    const key = await generateKey()
    const corrupted: SnapshotManifest = {
      chunkCount: 2,
      totalBytes: ENVELOPE_OVERHEAD, // < 2 * ENVELOPE_OVERHEAD
      maxChunkBytes: ENVELOPE_OVERHEAD + 1,
    }
    const store = new SealedDocumentStore(manifestOnlyInner(corrupted), fixedKeyProvider(key, 0))
    await expect(store.readSnapshotManifest({ docRef })).rejects.toBeInstanceOf(
      StoredDocumentUnreadableError,
    )
    await expect(store.loadSnapshot({ docRef })).rejects.toBeInstanceOf(
      StoredDocumentUnreadableError,
    )
  })

  it('refuses a maxChunkBytes at or below ENVELOPE_OVERHEAD', async () => {
    const key = await generateKey()
    const corrupted: SnapshotManifest = {
      chunkCount: 1,
      totalBytes: ENVELOPE_OVERHEAD + 1,
      maxChunkBytes: ENVELOPE_OVERHEAD,
    }
    const store = new SealedDocumentStore(manifestOnlyInner(corrupted), fixedKeyProvider(key, 0))
    await expect(store.readSnapshotManifest({ docRef })).rejects.toBeInstanceOf(
      StoredDocumentUnreadableError,
    )
    await expect(store.loadSnapshot({ docRef })).rejects.toBeInstanceOf(
      StoredDocumentUnreadableError,
    )
  })
})

function plaintextProvider(): ReplicaKeyProvider {
  return { keyFor: async () => 'plaintext' }
}

describe('envelope encoding', () => {
  it('rejects an unknown version byte and a buffer shorter than the minimum envelope', () => {
    const tooShort = new Uint8Array(32)
    tooShort[0] = 0x01
    expect(() => decodeEnvelope(tooShort)).toThrow()

    const wrongVersion = new Uint8Array(33)
    wrongVersion[0] = 0x02
    expect(() => decodeEnvelope(wrongVersion)).toThrow()
  })

  it('rejects an epoch outside the u32 field width instead of silently wrapping it', () => {
    const envelope = { v: 1 as const, iv: randomBytes(12), ct: randomBytes(16), epoch: 2 ** 32 }
    expect(() => encodeEnvelope(envelope)).toThrow(RangeError)
  })

  fcTest.prop(
    [
      fc.uint8Array({ minLength: 12, maxLength: 12 }),
      fc.uint8Array({ minLength: 16, maxLength: 64 }),
      fc.nat({ max: 2 ** 32 - 1 }),
    ],
    withDefaults({ numRuns: 15 }),
  )(
    'encode then decode is the identity, and the encoded length is exactly 17 + ct.byteLength',
    (iv, ct, epoch) => {
      const envelope = { v: 1 as const, iv, ct, epoch }
      const encoded = encodeEnvelope(envelope)
      expect(encoded.byteLength).toBe(17 + ct.byteLength)
      const decoded = decodeEnvelope(encoded)
      expect(decoded.epoch).toBe(epoch)
      expect([...decoded.iv]).toEqual([...iv])
      expect([...decoded.ct]).toEqual([...ct])
    },
  )
})
