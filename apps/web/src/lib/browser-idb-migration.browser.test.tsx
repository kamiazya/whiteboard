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
    // The old names are DELETED, not merely abandoned. A store left in place
    // would keep a second copy of every document readable by anything that
    // still remembers the old name.
    expect([...db.objectStoreNames].sort()).toEqual([
      'documentFiles',
      'documents',
      'loroDocuments',
      'meta',
    ])

    const fileCount = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction('documentFiles', 'readonly')
      const req = tx.objectStore('documentFiles').count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
    expect(fileCount).toBe(1)

    // Read back through the PRODUCTION stores, which only know the new names:
    // a copy that lost its key or its value would fail here even though the
    // store-name assertion above passed.
    const loroResult = await new LoroStore().load(documentId)
    expect(loroResult.kind).toBe('ok')
    if (loroResult.kind === 'ok') {
      const restored = new Loro()
      restored.import(loroResult.snapshot)
      expect(restored.getList('elements').toArray()).toEqual([{ id: 'canonical-el' }])
    }

    const metaStore = new IndexedDBStore()
    const loadResult = await metaStore.load(documentId)
    expect(loadResult.kind).toBe('ok')
    if (loadResult.kind === 'ok') {
      expect(loadResult.snapshot.name).toBe('Pre-v7 document')
    }
  })

  it('carries the default pointer across the meta key rename', async () => {
    const documentId = 'document-migrate-v7-pointer'
    await seedV6Fixture(documentId, new Loro().export({ mode: 'snapshot' }))

    expect(await new IndexedDBStore().getDefaultDocumentId()).toBe(documentId)
    // The old key is removed rather than duplicated — two pointers could
    // disagree, and nothing would say which one won.
    expect(await metaKeys()).toEqual(['defaultDocumentId'])
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

describe('whiteboard IndexedDB v5 -> v6 upgrade (removes reconnectKeypairs)', () => {
  const LEGACY_RECONNECT_SECRET_KEY = 'whiteboard.reconnect-secret.v1'

  beforeEach(clearDb)
  afterEach(() => {
    localStorage.removeItem(LEGACY_RECONNECT_SECRET_KEY)
    return clearDb()
  })

  it('current DB_VERSION is 6 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(6)
  })

  it('removes the reconnectKeypairs store and the legacy localStorage secret while preserving canvases/loroCanvases/canvasFiles/meta', async () => {
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

    const loroStore = new LoroStore()
    const loroResult = await loroStore.load(documentId)
    expect(loroResult.kind).toBe('ok')

    const metaStore = new IndexedDBStore()
    expect(await metaStore.getDefaultDocumentId()).toBe(documentId)
    const loadResult = await metaStore.load(documentId)
    expect(loadResult.kind).toBe('ok')
    if (loadResult.kind === 'ok') {
      expect(loadResult.snapshot.name).toBe('Pre-v6 canvas')
    }

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

describe('whiteboard IndexedDB v4 -> v5 upgrade', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('current DB_VERSION is 5 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(5)
  })

  it('opening a v4 database at the current version never leaves reconnectKeypairs behind and preserves existing canvasFiles/loroCanvases/documents/meta contents', async () => {
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

    const loroStore = new LoroStore()
    const loroResult = await loroStore.load(documentId)
    expect(loroResult.kind).toBe('ok')

    const metaStore = new IndexedDBStore()
    expect(await metaStore.getDefaultDocumentId()).toBe(documentId)
    const loadResult = await metaStore.load(documentId)
    expect(loadResult.kind).toBe('ok')
    if (loadResult.kind === 'ok') {
      expect(loadResult.snapshot.name).toBe('Pre-v5 canvas')
    }
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

    const loroStore = new LoroStore()
    const loroResult = await loroStore.load(documentId)
    expect(loroResult.kind).toBe('ok')

    const metaStore = new IndexedDBStore()
    expect(await metaStore.getDefaultDocumentId()).toBe(documentId)
    const loadResult = await metaStore.load(documentId)
    expect(loadResult.kind).toBe('ok')
    if (loadResult.kind === 'ok') {
      expect(loadResult.snapshot.name).toBe('Pre-v4 canvas')
    }
  })
})

describe('whiteboard IndexedDB v2 -> v3 upgrade', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('current DB_VERSION is 3 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(3)
  })

  it('opens a seeded v2 fixture at the current version without VersionError, strips scene, and keeps loroCanvases canonical', async () => {
    const documentId = 'canvas-migrate-1'
    const doc = new Loro()
    doc.getList('elements').push({ id: 'canonical-el' })
    const loroSnapshot = doc.export({ mode: 'snapshot' })
    await seedV2Fixture(documentId, loroSnapshot)

    // (a) Open through the shared opener at the current DB_VERSION — must not VersionError.
    const db = await openWhiteboardDb()
    db.close()

    // (b) The loroCanvases record survives and its elements are canonical after load.
    const loroStore = new LoroStore()
    const loroResult = await loroStore.load(documentId)
    expect(loroResult.kind).toBe('ok')
    if (loroResult.kind === 'ok') {
      const restored = new Loro()
      restored.import(loroResult.snapshot)
      expect(restored.getList('elements').toArray()).toEqual([{ id: 'canonical-el' }])
    }

    // (c) The 'documents' row has no scene / no old-schema orphan remains.
    // Checked against the RAW stored row (not the parsed load() result): Zod's
    // z.object() silently strips unrecognized keys from its parsed OUTPUT even
    // when the underlying row still carries them, so asserting only against
    // loadResult.snapshot would pass even if the upgrade never ran.
    const rawRow = await readRawDocumentsRow(documentId)
    expect(rawRow).not.toHaveProperty('scene')
    expect(rawRow).toEqual({
      id: documentId,
      name: 'Pre-migration canvas',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const metaStore = new IndexedDBStore()
    const loadResult = await metaStore.load(documentId)
    expect(loadResult.kind).toBe('ok')
    if (loadResult.kind === 'ok') {
      expect(loadResult.snapshot).toEqual({
        id: documentId,
        name: 'Pre-migration canvas',
        updatedAt: '2026-01-01T00:00:00.000Z',
        // Not stored in the v2 fixture: the schema's own default — a
        // pre-kind row parses as a spatial canvas with no migration.
        kind: 'spatial',
      })
    }

    // (d) The default pointer/id is intact.
    expect(await metaStore.getDefaultDocumentId()).toBe(documentId)
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
        tx.onerror = () => reject(tx.error)
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
