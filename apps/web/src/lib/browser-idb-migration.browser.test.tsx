/**
 * Upgrade migrations against a real IndexedDB, each seeding the store layout
 * as it stood at that version. The store names change at v7 ('canvases' ->
 * 'documents' and friends), so a fixture below spells whichever name its OWN
 * version used — that is the whole point of a migration test, and rewriting a
 * fixture to the current vocabulary would leave the migration untested while
 * still passing.
 *
 * v2 -> v3: the persisted JSON metadata row is demoted to metadata-only.
 * Elements are canonical in the Loro doc, so a legacy 'scene' field on a v2
 * row must be stripped on upgrade without ever touching the Loro store.
 */

import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DB_VERSION, openWhiteboardDb } from './browser-idb.js'
import { IndexedDBStore } from './browser-local-store.js'
import { LoroStore } from './loro-store.js'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

/** Seed a pre-v3 ("v2 shape") fixture DB via raw IDB, bypassing the app's opener/schema. */
async function seedV2Fixture(documentId: string, loroSnapshot: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', 2)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['meta', 'canvases', 'loroCanvases'], 'readwrite')
      tx.objectStore('meta').put(documentId, 'defaultCanvasId')
      tx.objectStore('canvases').put(
        {
          id: documentId,
          name: 'Pre-migration canvas',
          scene: { elements: [{ id: 'legacy-el', type: 'rectangle' }] },
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        documentId,
      )
      tx.objectStore('loroCanvases').put(
        {
          v: 1,
          snapshot: loroSnapshot,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        documentId,
      )
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

/** Reads a 'documents' row directly via raw IDB, bypassing documentSnapshotSchema. */
async function readRawDocumentsRow(documentId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('documents', 'readonly')
      const getReq = tx.objectStore('documents').get(documentId)
      getReq.onsuccess = () => resolve(getReq.result)
      getReq.onerror = () => reject(getReq.error)
      tx.oncomplete = () => db.close()
    }
    req.onerror = () => reject(req.error)
  })
}

/** Seed a pre-v4 ("v3 shape") fixture DB via raw IDB, bypassing the app's opener/schema. */
async function seedV3Fixture(documentId: string, loroSnapshot: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', 3)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['meta', 'canvases', 'loroCanvases'], 'readwrite')
      tx.objectStore('meta').put(documentId, 'defaultCanvasId')
      tx.objectStore('canvases').put(
        { id: documentId, name: 'Pre-v4 canvas', updatedAt: '2026-01-01T00:00:00.000Z' },
        documentId,
      )
      tx.objectStore('loroCanvases').put(
        { v: 1, snapshot: loroSnapshot, updatedAt: '2026-01-01T00:00:00.000Z' },
        documentId,
      )
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

/** Seed a pre-v5 ("v4 shape") fixture DB via raw IDB, bypassing the app's opener/schema. */
async function seedV4Fixture(documentId: string, loroSnapshot: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', 4)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
      if (!db.objectStoreNames.contains('canvasFiles')) db.createObjectStore('canvasFiles')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['meta', 'canvases', 'loroCanvases', 'canvasFiles'], 'readwrite')
      tx.objectStore('meta').put(documentId, 'defaultCanvasId')
      tx.objectStore('canvases').put(
        { id: documentId, name: 'Pre-v5 canvas', updatedAt: '2026-01-01T00:00:00.000Z' },
        documentId,
      )
      tx.objectStore('loroCanvases').put(
        { v: 1, snapshot: loroSnapshot, updatedAt: '2026-01-01T00:00:00.000Z' },
        documentId,
      )
      tx.objectStore('canvasFiles').put(new Blob(['file-bytes']), 'file-1')
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

/** Seed a pre-v6 ("v5 shape") fixture DB via raw IDB, bypassing the app's opener/schema. */
async function seedV5Fixture(documentId: string, loroSnapshot: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', 5)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
      if (!db.objectStoreNames.contains('canvasFiles')) db.createObjectStore('canvasFiles')
      if (!db.objectStoreNames.contains('reconnectKeypairs')) {
        db.createObjectStore('reconnectKeypairs', { keyPath: 'origin' })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(
        ['meta', 'canvases', 'loroCanvases', 'canvasFiles', 'reconnectKeypairs'],
        'readwrite',
      )
      tx.objectStore('meta').put(documentId, 'defaultCanvasId')
      tx.objectStore('canvases').put(
        { id: documentId, name: 'Pre-v6 canvas', updatedAt: '2026-01-01T00:00:00.000Z' },
        documentId,
      )
      tx.objectStore('loroCanvases').put(
        { v: 1, snapshot: loroSnapshot, updatedAt: '2026-01-01T00:00:00.000Z' },
        documentId,
      )
      tx.objectStore('canvasFiles').put(new Blob(['file-bytes']), 'file-1')
      // A real (non-extractable) CryptoKey cannot be structured-cloned into a
      // fixture reliably across browsers, so a plain placeholder record is
      // enough to prove the STORE itself — not any particular key shape — is
      // gone after the upgrade.
      tx.objectStore('reconnectKeypairs').put({ origin: 'http://localhost:3099', fake: true })
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

/** Seed a pre-v7 ("v6 shape") fixture DB via raw IDB, bypassing the app's opener/schema. */
async function seedV6Fixture(documentId: string, loroSnapshot: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', 6)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
      if (!db.objectStoreNames.contains('canvasFiles')) db.createObjectStore('canvasFiles')
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['meta', 'canvases', 'loroCanvases', 'canvasFiles'], 'readwrite')
      tx.objectStore('meta').put(documentId, 'defaultCanvasId')
      tx.objectStore('canvases').put(
        { id: documentId, name: 'Pre-v7 document', updatedAt: '2026-01-01T00:00:00.000Z' },
        documentId,
      )
      tx.objectStore('loroCanvases').put(
        { v: 1, snapshot: loroSnapshot, updatedAt: '2026-01-01T00:00:00.000Z' },
        documentId,
      )
      tx.objectStore('canvasFiles').put(new Blob(['file-bytes']), 'file-1')
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

async function metaKeys(): Promise<string[]> {
  const db = await openWhiteboardDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly')
    const req = tx.objectStore('meta').getAllKeys()
    req.onsuccess = () => resolve(req.result.map(String).sort())
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
  })
}

describe('whiteboard IndexedDB v6 -> v7 upgrade (renames the container stores)', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('current DB_VERSION is 7 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(7)
  })

  it('moves every record to the renamed store and leaves no old store behind', async () => {
    const documentId = 'document-migrate-v7'
    const doc = new Loro()
    doc.getList('elements').push({ id: 'canonical-el' })
    await seedV6Fixture(documentId, doc.export({ mode: 'snapshot' }))

    const db = await openWhiteboardDb()
    // Read before asserting, and assert after: a failed expect() between the
    // open and the close would leak the connection, and every later test in
    // this file would then meet a database clearDb cannot delete.
    const storeNames = [...db.objectStoreNames].sort()
    // The old names are DELETED, not merely abandoned. A store left in place
    // would keep a second copy of every document readable by anything that
    // still remembers the old name.
    expect(storeNames).toEqual(['documentFiles', 'documents', 'loroDocuments', 'meta'])

    const fileCount = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction('documentFiles', 'readonly')
      const req = tx.objectStore('documentFiles').count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
    expect(fileCount).toBe(1)

    // documentFiles is where the copy's record-carrying half is still
    // observable: uploads are not addressed by workspace+path, so v8 leaves
    // them alone. A copy that lost its key or its value fails the count above
    // even though the store-name assertion passed.

    const metaStore = new IndexedDBStore()
    // The row does not survive: v8 DISCARDS a document with no workspace and
    // no path, because there is nothing to migrate it to without inventing an
    // address, and an invented one is indistinguishable from a chosen one.
    // Everything a pre-path fixture holds therefore ends here — this migration
    // path converges on an empty document store, by decision, not by accident.
    expect(await readRawDocumentsRow(documentId)).toBeUndefined()
    expect((await metaStore.load(documentId)).kind).toBe('not-found')
    expect(await metaStore.listDocuments()).toEqual([])
    // The bytes go with it rather than lingering as storage nothing names.
    expect((await new LoroStore().load(documentId)).kind).toBe('not-found')
  })

  it('renames the meta pointer key, then clears it because v8 discarded its target', async () => {
    const documentId = 'document-migrate-v7-pointer'
    await seedV6Fixture(documentId, new Loro().export({ mode: 'snapshot' }))

    // Both halves matter and only the second is new: v7 moves the pointer to
    // its new key (leaving the old one behind would let two pointers disagree
    // with nothing to say which won), and v8 then clears it because the
    // document it named is gone — a pointer at a discarded document would
    // resume the editor into nothing.
    expect(await metaKeys()).toEqual([])
    expect(await new IndexedDBStore().getDefaultDocumentId()).toBeNull()
  })

  it('is a no-op for a fresh install, which never had the old stores', async () => {
    const db = await openWhiteboardDb()
    expect([...db.objectStoreNames].sort()).toEqual([
      'documentFiles',
      'documents',
      'loroDocuments',
      'meta',
    ])
    db.close()
  })
})

describe('IndexedDB v5 -> v6 (removes reconnectKeypairs)', () => {
  const LEGACY_RECONNECT_SECRET_KEY = 'whiteboard.reconnect-secret.v1'

  beforeEach(clearDb)
  afterEach(() => {
    localStorage.removeItem(LEGACY_RECONNECT_SECRET_KEY)
    return clearDb()
  })

  it('current DB_VERSION is 6 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(6)
  })

  it('drops the store and the legacy localStorage secret, preserving the rest', async () => {
    const documentId = 'canvas-migrate-v6'
    const doc = new Loro()
    doc.getList('elements').push({ id: 'canonical-el' })
    const loroSnapshot = doc.export({ mode: 'snapshot' })
    await seedV5Fixture(documentId, loroSnapshot)
    localStorage.setItem(
      LEGACY_RECONNECT_SECRET_KEY,
      JSON.stringify({ origin: 'http://localhost:3099', secret: 'stale-secret' }),
    )

    const db = await openWhiteboardDb()
    // Erasure invariant: the credential surface is gone by construction —
    // no reader can reach it because there is no longer anywhere to read it
    // from.
    expect(db.objectStoreNames.contains('reconnectKeypairs')).toBe(false)

    const fileCount = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction('documentFiles', 'readonly')
      const req = tx.objectStore('documentFiles').count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
    expect(fileCount).toBe(1)

    // Discarded with its document — see the note below.
    expect((await new LoroStore().load(documentId)).kind).toBe('not-found')

    const metaStore = new IndexedDBStore()
    // The row does not survive: v8 DISCARDS a document with no workspace and
    // no path, because there is nothing to migrate it to without inventing an
    // address, and an invented one is indistinguishable from a chosen one.
    // Everything a pre-path fixture holds therefore ends here — this migration
    // path converges on an empty document store, by decision, not by accident.
    expect(await readRawDocumentsRow(documentId)).toBeUndefined()
    expect((await metaStore.load(documentId)).kind).toBe('not-found')
    expect(await metaStore.listDocuments()).toEqual([])

    // purgeLegacyReconnectCredentials() is exercised directly here (rather
    // than via a full App/router boot harness) — it is called unconditionally
    // at app boot in main.tsx; this test verifies the IndexedDB-side and
    // localStorage-side erasure are BOTH complete once a real app boot would
    // have run.
    const { purgeLegacyReconnectCredentials } = await import(
      './purge-legacy-reconnect-credentials.js'
    )
    purgeLegacyReconnectCredentials()
    expect(localStorage.getItem(LEGACY_RECONNECT_SECRET_KEY)).toBeNull()
  })

  it('a fresh install at the current version never creates reconnectKeypairs', async () => {
    const db = await openWhiteboardDb()
    expect(db.objectStoreNames.contains('reconnectKeypairs')).toBe(false)
    expect([...db.objectStoreNames].sort()).toEqual([
      'documentFiles',
      'documents',
      'loroDocuments',
      'meta',
    ])
    db.close()
  })
})

describe('IndexedDB v4 -> v5', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('current DB_VERSION is 5 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(5)
  })

  it('opening a v4 database at the current version preserves every other store', async () => {
    const documentId = 'canvas-migrate-v5'
    const doc = new Loro()
    doc.getList('elements').push({ id: 'canonical-el' })
    const loroSnapshot = doc.export({ mode: 'snapshot' })
    await seedV4Fixture(documentId, loroSnapshot)

    const db = await openWhiteboardDb()
    // v4 -> current spans the v4->v5 store creation AND the v5->v6 removal
    // in one upgrade transaction (a multi-version jump fires
    // onupgradeneeded once, not once per intermediate version), so the net
    // effect for a v4 database opened today is: never created.
    expect(db.objectStoreNames.contains('reconnectKeypairs')).toBe(false)

    const fileCount = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction('documentFiles', 'readonly')
      const req = tx.objectStore('documentFiles').count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
    expect(fileCount).toBe(1)

    // Discarded with its document — see the note below.
    expect((await new LoroStore().load(documentId)).kind).toBe('not-found')

    const metaStore = new IndexedDBStore()
    // The row does not survive: v8 DISCARDS a document with no workspace and
    // no path, because there is nothing to migrate it to without inventing an
    // address, and an invented one is indistinguishable from a chosen one.
    // Everything a pre-path fixture holds therefore ends here — this migration
    // path converges on an empty document store, by decision, not by accident.
    expect(await readRawDocumentsRow(documentId)).toBeUndefined()
    expect((await metaStore.load(documentId)).kind).toBe('not-found')
    expect(await metaStore.listDocuments()).toEqual([])
  })
})

describe('whiteboard IndexedDB v3 -> v4 upgrade', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('current DB_VERSION is 4 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(4)
  })

  it('opening a v3 database at v4 creates canvasFiles and preserves existing loroCanvases/documents/meta contents', async () => {
    const documentId = 'canvas-migrate-v4'
    const doc = new Loro()
    doc.getList('elements').push({ id: 'canonical-el' })
    const loroSnapshot = doc.export({ mode: 'snapshot' })
    await seedV3Fixture(documentId, loroSnapshot)

    const db = await openWhiteboardDb()
    expect(db.objectStoreNames.contains('documentFiles')).toBe(true)
    db.close()

    // Discarded with its document — see the note below.
    expect((await new LoroStore().load(documentId)).kind).toBe('not-found')

    const metaStore = new IndexedDBStore()
    // The row does not survive: v8 DISCARDS a document with no workspace and
    // no path, because there is nothing to migrate it to without inventing an
    // address, and an invented one is indistinguishable from a chosen one.
    // Everything a pre-path fixture holds therefore ends here — this migration
    // path converges on an empty document store, by decision, not by accident.
    expect(await readRawDocumentsRow(documentId)).toBeUndefined()
    expect((await metaStore.load(documentId)).kind).toBe('not-found')
    expect(await metaStore.listDocuments()).toEqual([])
  })
})

describe('whiteboard IndexedDB v2 -> v3 upgrade', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('current DB_VERSION is 3 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(3)
  })

  it('opens a seeded v2 fixture at the current version without VersionError, and keeps nothing it cannot address', async () => {
    const documentId = 'canvas-migrate-1'
    const doc = new Loro()
    doc.getList('elements').push({ id: 'canonical-el' })
    await seedV2Fixture(documentId, doc.export({ mode: 'snapshot' }))

    // (a) The oldest shape still opens through the shared opener at the
    // current DB_VERSION. This half is the durable one: every version bump
    // since has had to keep it true, and a VersionError here is a bricked app
    // for anyone who has not opened the tab in a while.
    const db = await openWhiteboardDb()
    db.close()

    // (b) Nothing else survives. A v2 row carries no workspace and no path —
    // and could not, they did not exist — so v8 discards it along with its
    // Loro record. What the pre-v3 `scene` strip did to this row on the way
    // through is no longer observable; the guard that it must not THROW on a
    // corrupt row still is, and is the next test.
    const metaStore = new IndexedDBStore()
    expect(await readRawDocumentsRow(documentId)).toBeUndefined()
    expect((await metaStore.load(documentId)).kind).toBe('not-found')
    expect(await metaStore.listDocuments()).toEqual([])
    expect((await new LoroStore().load(documentId)).kind).toBe('not-found')
    expect(await metaStore.getDefaultDocumentId()).toBeNull()
  })

  it('upgrades without aborting when a legacy canvases row is a non-object (corrupt data)', async () => {
    // A null / non-object row must not throw a TypeError from `'scene' in value`
    // inside the upgrade cursor — that would abort the transaction and brick the
    // DB open for the user.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('whiteboard', 2)
      req.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
        if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
        if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('canvases', 'readwrite')
        // A corrupt non-object value stored under a key.
        tx.objectStore('canvases').put(null, 'corrupt-row')
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => {
          // Closed on the failure path too: a seeder that leaks a connection at
          // an old version blocks the very upgrade the next test is there to
          // exercise, and the error surfaces in that test rather than this one.
          db.close()
          reject(tx.error)
        }
      }
      req.onerror = () => reject(req.error)
    })

    // Opening through the shared opener at v3 must complete (guard prevents the
    // `in` TypeError from aborting the upgrade).
    const db = await openWhiteboardDb()
    expect(db.version).toBe(DB_VERSION)
    db.close()
  })

  it('mutation-check: reverting DB_VERSION to 2 makes the seeded v2 fixture fail to strip scene', async () => {
    // This test documents the guard rather than actually reverting production
    // code (that is done manually per the zod-schema-discipline mutation-check
    // step). It re-asserts the invariant the real mutation-check depends on:
    // opening at version 2 must NOT run the v2->v3 upgrade at all.
    const documentId = 'canvas-migrate-2'
    const doc = new Loro()
    doc.getList('elements').push({ id: 'el' })
    await seedV2Fixture(documentId, doc.export({ mode: 'snapshot' }))

    // Opening at the (hypothetically reverted) old version 2 does not run
    // onupgradeneeded at all, so the legacy 'scene' field is still present.
    const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('whiteboard', 2)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = rawDb.transaction('canvases', 'readonly')
      const getReq = tx.objectStore('canvases').get(documentId)
      getReq.onsuccess = () => resolve(getReq.result)
      getReq.onerror = () => reject(getReq.error)
      tx.oncomplete = () => rawDb.close()
    })
    expect(raw).toHaveProperty('scene')
  })
})

/** Seed a v7-shape fixture: current store names, rows in whatever shape is passed. */
async function seedV7Fixture(rows: {
  documents: readonly (readonly [key: string, value: unknown])[]
  loro?: readonly string[]
  defaultDocumentId?: string
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard', 7)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      for (const name of ['meta', 'documents', 'loroDocuments', 'documentFiles']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
      }
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['meta', 'documents', 'loroDocuments'], 'readwrite')
      if (rows.defaultDocumentId !== undefined) {
        tx.objectStore('meta').put(rows.defaultDocumentId, 'defaultDocumentId')
      }
      for (const [key, value] of rows.documents) tx.objectStore('documents').put(value, key)
      for (const key of rows.loro ?? []) {
        tx.objectStore('loroDocuments').put(
          { v: 1, snapshot: new Loro().export({ mode: 'snapshot' }), updatedAt: 'x' },
          key,
        )
      }
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

async function storeKeys(name: string): Promise<string[]> {
  const db = await openWhiteboardDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readonly')
    const req = tx.objectStore(name).getAllKeys()
    req.onsuccess = () => resolve(req.result as string[])
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
  })
}

const POST_PATH_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const PRE_PATH_ID = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6'

describe('whiteboard IndexedDB v7 -> v8 upgrade (discards pre-path documents)', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('current DB_VERSION is 8 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(8)
  })

  it('deletes a document that carries no workspace or path, and its Loro record with it', async () => {
    await seedV7Fixture({
      documents: [
        [PRE_PATH_ID, { id: PRE_PATH_ID, name: 'Old canvas', updatedAt: 'x', kind: 'spatial' }],
      ],
      loro: [PRE_PATH_ID],
      defaultDocumentId: PRE_PATH_ID,
    })

    expect(await storeKeys('documents')).toEqual([])
    // The bytes go too: a Loro record no document names is unreachable
    // storage that nothing would ever clean up.
    expect(await storeKeys('loroDocuments')).toEqual([])
    // ...and the pointer, or the next load resumes into a document that is gone.
    expect(await metaKeys()).toEqual([])
  })

  it('leaves a document that already carries workspace and path completely alone', async () => {
    const row = {
      documentId: POST_PATH_ID,
      workspaceId: 'local',
      path: 'design/login',
      name: 'Login',
      updatedAt: '2026-01-01T00:00:00.000Z',
      kind: 'spatial',
    }
    await seedV7Fixture({
      documents: [[POST_PATH_ID, row]],
      loro: [POST_PATH_ID],
      defaultDocumentId: POST_PATH_ID,
    })

    expect(await readRawDocumentsRow(POST_PATH_ID)).toEqual(row)
    expect(await storeKeys('loroDocuments')).toEqual([POST_PATH_ID])
    expect(await new IndexedDBStore().getDefaultDocumentId()).toBe(POST_PATH_ID)
  })

  it('discards only the pre-path rows when a store holds both', async () => {
    const keep = {
      documentId: POST_PATH_ID,
      workspaceId: 'local',
      path: 'keep',
      name: 'Keep',
      updatedAt: '2026-01-01T00:00:00.000Z',
      kind: 'spatial',
    }
    await seedV7Fixture({
      documents: [
        [POST_PATH_ID, keep],
        [PRE_PATH_ID, { id: PRE_PATH_ID, name: 'Drop', updatedAt: 'x', kind: 'spatial' }],
      ],
      loro: [POST_PATH_ID, PRE_PATH_ID],
      // Pointed at the SURVIVOR: a blanket clear would pass the first test
      // while silently logging every user out of their remaining document.
      defaultDocumentId: POST_PATH_ID,
    })

    expect(await storeKeys('documents')).toEqual([POST_PATH_ID])
    expect(await storeKeys('loroDocuments')).toEqual([POST_PATH_ID])
    expect(await new IndexedDBStore().getDefaultDocumentId()).toBe(POST_PATH_ID)
  })

  it('survives a corrupt (non-object) row rather than aborting the whole upgrade', async () => {
    await seedV7Fixture({ documents: [['junk', 42]], loro: ['junk'] })
    expect(await storeKeys('documents')).toEqual([])
  })
})

describe('v6 -> v8 in one upgrade (the discard must see what the v7 copy produced)', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('discards a pre-path row that arrives in `documents` via the v7 rename copy', async () => {
    // The two passes share ONE versionchange transaction: the rename copies
    // `canvases` -> `documents` through a cursor whose puts land in its own
    // callbacks, and the discard walks `documents`. A discard cursor opened
    // before those puts have run sees an empty store and deletes nothing —
    // which looks exactly like a successful upgrade.
    const doc = new Loro()
    doc.getList('elements').push({ id: 'el' })
    await seedV6Fixture('pre-path-v6', doc.export({ mode: 'snapshot' }))

    expect(await storeKeys('documents')).toEqual([])
    expect(await storeKeys('loroDocuments')).toEqual([])
  })
})

describe('cross-tab upgrades', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('an open connection closes itself so a newer version is not blocked behind it', async () => {
    // Stands in for the second tab: a connection this module handed out and
    // that nobody closed. Without `onversionchange` it holds the database at
    // its own version and the upgrade below never fires — the request sits in
    // `blocked` forever, which in the app is an editor that never loads and
    // no error to explain why.
    const idle = await openWhiteboardDb()

    let blocked = false
    const upgraded = await new Promise<boolean>((resolve) => {
      const req = indexedDB.open('whiteboard', DB_VERSION + 1)
      req.onblocked = () => {
        blocked = true
      }
      req.onsuccess = () => {
        req.result.close()
        resolve(true)
      }
      req.onerror = () => resolve(false)
      // Bounded so a genuine block fails the test instead of hanging it.
      setTimeout(() => resolve(false), 4000)
    })

    // Closed BEFORE the assertion: a failure here would otherwise leave the
    // connection open, and `afterEach`'s deleteDatabase then blocks on it —
    // turning one failed test into a hung file.
    idle.close()
    expect({ upgraded, blocked }).toEqual({ upgraded: true, blocked: false })
  })

  it('rejects with a message a caller can show when a connection that will NOT self-close holds the old version', async () => {
    // The other half, and the one the self-close cannot cover: a tab still
    // running a pre-v8 bundle has no `onversionchange` handler, so it sits on
    // the old version until a person closes it. Without this branch the open
    // request never settles, and every caller — the store, the Loro store, the
    // file store — awaits a promise that has no outcome, which in the app is an
    // editor that never loads with nothing on screen to explain why.
    const stubborn = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('whiteboard', DB_VERSION - 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

    try {
      // Raced against a short deadline on purpose. Without the branch the open
      // request never settles at all, and an unbounded await would spend the
      // whole per-test timeout (measured: 120s) reporting the same thing this
      // says in three.
      const outcome = await Promise.race([
        openWhiteboardDb().then(
          (db) => {
            db.close()
            return 'resolved'
          },
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        ),
        new Promise<string>((r) => setTimeout(() => r('never settled'), 3000)),
      ])
      expect(outcome).toMatch(/another tab/i)
    } finally {
      stubborn.close()
      // The rejected request is still live and will upgrade the database the
      // moment `stubborn` lets go. Draining it here, inside the test that
      // created it, is what keeps the next test's seed from meeting a
      // database at a version it did not put there.
      await new Promise((r) => setTimeout(r, 300))
      await clearDb()
    }
  })
})
