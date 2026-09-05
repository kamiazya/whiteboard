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

// Stays in REAL-browser mode on purpose: this file is part of the real-IDB
// fidelity contract (transaction/upgrade/abort semantics fake-indexeddb only
// approximates). IndexedDB-only suites with no such stake run in jsdom via
// fake-indexeddb instead — see e.g. local-document-summary.test.tsx.
import {
  adoptWorkspaceDocument,
  resolveWorkspaceDocumentById,
} from '@kamiazya/whiteboard-loro-adapter'
import { workspaceSegmentSchema } from '@kamiazya/whiteboard-model'
import { chunkSnapshot, type SnapshotChunk } from '@kamiazya/whiteboard-ports'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import {
  BROWSER_DEFAULT_SEGMENT,
  DB_VERSION,
  DOCUMENT_INDEX_STORE,
  mintBrowserWorkspaceSegment,
  openWhiteboardDb,
  rekeyBrowserWorkspace,
  SYNC_DOCUMENTS_STORE,
  SYNC_SNAPSHOT_CHUNKS_STORE,
  WORKSPACES_STORE,
} from './browser-idb.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import {
  getBrowserWorkspaceId,
  resetBrowserWorkspaceIdForTests,
  resolveBrowserWorkspaceId,
} from './browser-workspace-id.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import {
  IdbDefaultDocumentPointer,
  idbContentClock,
  listLocalDocuments,
  loadLocalDocument,
} from './local-document-summary.js'
import { LoroStore } from './loro-store.js'
import { purgeLegacyReconnectCredentials } from './purge-legacy-reconnect-credentials.js'

/**
 * This file's own database.
 *
 * Twelve browser test files touch the shared `whiteboard` database, and they
 * share an origin — so IndexedDB is one global object across all of them. Only
 * this file deliberately parks that database at OLD versions to exercise the
 * upgrades, which makes it the one file whose fixtures can block another's
 * open (and be blocked by it) with `another tab has this app open at an older
 * version`. The name is a parameter precisely so this file can stop
 * participating; nothing was passing it.
 */
const MIGRATION_DB = 'whiteboard-migration-test'

// Every test in this file re-seeds MIGRATION_DB from scratch (see `(() => clearNamedDb(MIGRATION_DB))`
// below), so the id `getBrowserWorkspaceId()` would answer is different on
// every run — a v13 fixture's rekey step mints a fresh ULID each time the
// database is torn down and rebuilt. Resetting the accessor's cache before
// each test (rather than relying on the shared jsdom-only seam, which this
// browser-mode file has none of) is what keeps `migratedLocal()` reading the
// id THIS test's database actually holds instead of the previous test's.
beforeEach(resetBrowserWorkspaceIdForTests)

/**
 * The migrated database read back through the production wiring, rather than
 * through a test double: what this file asserts is what a real user's next
 * session would see after the upgrade ran.
 *
 * `listDocuments`/`load` resolve the workspace id fresh (idempotent once
 * resolved for this test) before delegating, rather than assuming it is
 * already resolved — production makes that same resolve part of the boot
 * chain (`boot.ts`), which nothing in this file drives.
 */
function migratedLocal() {
  const index = new IdbDocumentIndex(MIGRATION_DB)
  const clock = idbContentClock(MIGRATION_DB)
  const ready = () => resolveBrowserWorkspaceId(MIGRATION_DB)
  return {
    listDocuments: () => ready().then(() => listLocalDocuments(index, clock)),
    load: (documentId: string) => ready().then(() => loadLocalDocument(index, documentId, clock)),
    getDefaultDocumentId: () => new IdbDefaultDocumentPointer(MIGRATION_DB).get(),
  }
}

/**
 * `LoroStore` builds a `DocRef` that reads `getBrowserWorkspaceId()` (unused
 * for `document:` keys, but still read — see `docRefKey`'s comment). A raw
 * construction in these fixtures has to resolve it explicitly, the way
 * production's boot chain always has by the time anything calls this.
 */
async function loroStore(): Promise<LoroStore> {
  await resolveBrowserWorkspaceId(MIGRATION_DB)
  return new LoroStore(MIGRATION_DB)
}

/**
 * Give a fixture connection the same manners the app's own opener has.
 *
 * `openWhiteboardDb` sets `onversionchange` so a live connection steps aside
 * when something needs a newer version. A raw `indexedDB.open` here does not,
 * and that asymmetry is the whole failure: a fixture connection that outlives
 * its `await` — every one of these resolves from a request callback while
 * `db.close()` still waits on `tx.oncomplete` — holds the database at its old
 * version, and the next open blocks with `another tab has this app open at an
 * older version`, reported against whichever test happens to be running.
 *
 * Closing promptly would also work and is not enough on its own: it makes the
 * window small rather than absent, which is why this file passed locally for
 * two attempts while CI kept failing. Stepping aside removes the window.
 *
 * The one connection that must NOT do this is the deliberately stubborn one in
 * `cross-tab upgrades`, which exists to prove what happens without it.
 */
function letFixtureStepAside(db: IDBDatabase): void {
  db.onversionchange = () => db.close()
}

/** Seed a pre-v3 ("v2 shape") fixture DB via raw IDB, bypassing the app's opener/schema. */
async function seedV2Fixture(documentId: string, loroSnapshot: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MIGRATION_DB, 2)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
    }
    req.onsuccess = () => {
      const db = req.result
      letFixtureStepAside(db)
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

/** Seed a pre-v4 ("v3 shape") fixture DB via raw IDB, bypassing the app's opener/schema. */
async function seedV3Fixture(documentId: string, loroSnapshot: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MIGRATION_DB, 3)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
    }
    req.onsuccess = () => {
      const db = req.result
      letFixtureStepAside(db)
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
    const req = indexedDB.open(MIGRATION_DB, 4)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
      if (!db.objectStoreNames.contains('canvasFiles')) db.createObjectStore('canvasFiles')
    }
    req.onsuccess = () => {
      const db = req.result
      letFixtureStepAside(db)
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
    const req = indexedDB.open(MIGRATION_DB, 5)
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
      letFixtureStepAside(db)
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
    const req = indexedDB.open(MIGRATION_DB, 6)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
      if (!db.objectStoreNames.contains('canvasFiles')) db.createObjectStore('canvasFiles')
    }
    req.onsuccess = () => {
      const db = req.result
      letFixtureStepAside(db)
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
  const db = await openWhiteboardDb(MIGRATION_DB)
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly')
    const req = tx.objectStore('meta').getAllKeys()
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => {
      db.close()
      resolve(req.result.map(String).sort())
    }
  })
}

/**
 * Seeds a v13-shaped fixture via raw IDB: the current store layout (v9-v12
 * additive changes already landed), keyed under the literal `'local'`
 * workspace the v13->v14 rekey step exists to move off of. Every store this
 * touches already existed by v13 — only the registry's KEY changes at v14 —
 * so this creates them directly rather than replaying the intermediate
 * upgrades the earlier fixtures above exercise.
 */
async function seedV13Fixture(input: {
  documentId: string
  path: string
  kind?: string
  name?: string
  contentSnapshot: Uint8Array
  workspaceTreeSnapshot?: Uint8Array
  defaultDocumentId?: string
}): Promise<void> {
  function writeEnvelope(tx: IDBTransaction, key: string, snapshot: Uint8Array): void {
    const { manifest, chunks } = chunkSnapshot(snapshot, 1_000_000)
    tx.objectStore(SYNC_DOCUMENTS_STORE).put(
      { v: 2, snapshot: { manifest }, frontier: new Uint8Array(), deltas: [] },
      key,
    )
    const chunkStore = tx.objectStore(SYNC_SNAPSHOT_CHUNKS_STORE)
    for (const chunk of chunks as SnapshotChunk[]) chunkStore.put(chunk, [key, chunk.index])
  }

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MIGRATION_DB, 13)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains(WORKSPACES_STORE)) db.createObjectStore(WORKSPACES_STORE)
      if (!db.objectStoreNames.contains(DOCUMENT_INDEX_STORE)) {
        const idx = db.createObjectStore(DOCUMENT_INDEX_STORE, { keyPath: ['workspaceId', 'path'] })
        idx.createIndex('byId', ['workspaceId', 'documentId'], { unique: true })
      }
      if (!db.objectStoreNames.contains('documentFiles')) db.createObjectStore('documentFiles')
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs')
      if (!db.objectStoreNames.contains(SYNC_DOCUMENTS_STORE))
        db.createObjectStore(SYNC_DOCUMENTS_STORE)
      if (!db.objectStoreNames.contains(SYNC_SNAPSHOT_CHUNKS_STORE)) {
        db.createObjectStore(SYNC_SNAPSHOT_CHUNKS_STORE)
      }
      if (!db.objectStoreNames.contains('contentTimestamps'))
        db.createObjectStore('contentTimestamps')
    }
    req.onsuccess = () => {
      const db = req.result
      letFixtureStepAside(db)
      const tx = db.transaction(
        [
          'meta',
          WORKSPACES_STORE,
          DOCUMENT_INDEX_STORE,
          SYNC_DOCUMENTS_STORE,
          SYNC_SNAPSHOT_CHUNKS_STORE,
        ],
        'readwrite',
      )
      tx.objectStore(WORKSPACES_STORE).put({ workspaceId: 'local' }, 'local')
      tx.objectStore(DOCUMENT_INDEX_STORE).add({
        workspaceId: 'local',
        documentId: input.documentId,
        path: input.path,
        kind: input.kind ?? 'spatial',
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      if (input.defaultDocumentId !== undefined) {
        tx.objectStore('meta').put(input.defaultDocumentId, 'defaultDocumentId')
      }
      writeEnvelope(tx, `document:${input.documentId}`, input.contentSnapshot)
      if (input.workspaceTreeSnapshot !== undefined) {
        writeEnvelope(tx, 'workspace-tree:local', input.workspaceTreeSnapshot)
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

/** Every key currently stored under the literal `'local'` workspace, across
 *  all three stores the rekey touches — the "zero remnants" assertion. */
/**
 * Opens the database at whatever version it currently holds, rather than
 * `openWhiteboardDb`'s pinned `DB_VERSION` — the one caller that needs this
 * (`two-bump idempotence`, below) deliberately forces the database past
 * `DB_VERSION`, and `openWhiteboardDb` would then reject with `VersionError`
 * ("requested version is less than the existing version").
 */
async function openAtCurrentVersion(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function legacyLocalKeys(): Promise<{
  workspaces: string[]
  index: unknown[]
  syncTree: string[]
}> {
  const db = await openAtCurrentVersion(MIGRATION_DB)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [WORKSPACES_STORE, DOCUMENT_INDEX_STORE, SYNC_DOCUMENTS_STORE],
      'readonly',
    )
    const workspacesReq = tx.objectStore(WORKSPACES_STORE).getAllKeys()
    const range = IDBKeyRange.bound(['local'], ['local', []])
    const indexReq = tx.objectStore(DOCUMENT_INDEX_STORE).getAll(range)
    const syncReq = tx.objectStore(SYNC_DOCUMENTS_STORE).getAllKeys()
    tx.onerror = () => reject(tx.error)
    tx.oncomplete = () => {
      db.close()
      resolve({
        workspaces: workspacesReq.result.map(String).filter((key) => key === 'local'),
        index: indexReq.result,
        syncTree: syncReq.result.map(String).filter((key) => key === 'workspace-tree:local'),
      })
    }
  })
}

const V13_DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe("IndexedDB v13 -> v14 (re-keys the 'local' workspace)", () => {
  beforeEach(() => clearNamedDb(MIGRATION_DB))
  afterEach(() => clearNamedDb(MIGRATION_DB))

  it('current DB_VERSION is 14 or higher', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(14)
  })

  it('moves registry, index and tree rows onto one ULID, zero local rows left', async () => {
    const contentDoc = new Loro()
    contentDoc.getMovableList('elements').push('one')
    const contentSnapshot = contentDoc.export({ mode: 'snapshot' })

    // A folded workspace document holding the SAME document as a tree node —
    // real Loro bytes, not a placeholder, so "the workspace tree opens under
    // the new key" is an actual read, not a shape assertion.
    const workspaceDoc = new Loro()
    adoptWorkspaceDocument(
      workspaceDoc,
      { path: 'design/login', documentId: V13_DOCUMENT_ID, kind: 'spatial', name: 'Login' },
      contentDoc,
    )
    const workspaceTreeSnapshot = workspaceDoc.export({ mode: 'snapshot' })

    await seedV13Fixture({
      documentId: V13_DOCUMENT_ID,
      path: 'design/login',
      name: 'Login',
      contentSnapshot,
      workspaceTreeSnapshot,
      defaultDocumentId: V13_DOCUMENT_ID,
    })

    const ulid = await resolveBrowserWorkspaceId(MIGRATION_DB)
    expect(ulid).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)

    // Documents list/load byte-identical through production wiring.
    const local = migratedLocal()
    expect((await local.listDocuments()).map((d) => d.documentId)).toEqual([V13_DOCUMENT_ID])
    const loaded = await new LoroStore(MIGRATION_DB).load(V13_DOCUMENT_ID)
    expect(loaded.kind).toBe('ok')
    if (loaded.kind === 'ok') expect([...loaded.snapshot]).toEqual([...contentSnapshot])
    expect(await local.getDefaultDocumentId()).toBe(V13_DOCUMENT_ID)

    // The workspace tree opens under the new key and holds the same node.
    const tree = await new BrowserWorkspaceDocs(MIGRATION_DB).open(ulid)
    expect(tree).not.toBeNull()
    if (tree !== null) {
      expect(resolveWorkspaceDocumentById(tree, V13_DOCUMENT_ID)).not.toBeNull()
    }

    // The registry holds exactly one ULID-keyed row.
    const db = await openWhiteboardDb(MIGRATION_DB)
    const workspaceKeys = await new Promise<string[]>((resolveKeys, rejectKeys) => {
      const tx = db.transaction(WORKSPACES_STORE, 'readonly')
      const req = tx.objectStore(WORKSPACES_STORE).getAllKeys()
      req.onerror = () => rejectKeys(req.error)
      tx.oncomplete = () => {
        db.close()
        resolveKeys(req.result.map(String))
      }
    })
    expect(workspaceKeys).toEqual([ulid])

    // Zero 'local'-keyed rows anywhere.
    const remnants = await legacyLocalKeys()
    expect(remnants).toEqual({ workspaces: [], index: [], syncTree: [] })
  })

  it("two-bump idempotence: same id both passes, re-put 'local' absorbed not stray", async () => {
    const contentDoc = new Loro()
    contentDoc.getMovableList('elements').push('stable')
    await seedV13Fixture({
      documentId: V13_DOCUMENT_ID,
      path: 'stable-doc',
      contentSnapshot: contentDoc.export({ mode: 'snapshot' }),
    })

    const firstUlid = await resolveBrowserWorkspaceId(MIGRATION_DB)

    // Simulates what a REAL future migration bump would do — re-fire
    // `onupgradeneeded` and let `backfillDocumentIndex` re-put
    // `{workspaceId:'local'}` unconditionally — without replaying the whole
    // upgrade chain (which reads stores like `documents`/`loroDocuments`
    // that no longer exist by v14). Manually re-seeding the exact remnant
    // `backfillDocumentIndex` would produce, then invoking the REAL exported
    // `rekeyBrowserWorkspace` against it inside a genuine versionchange
    // transaction, tests the actual convergence logic rather than a
    // re-implementation of it.
    resetBrowserWorkspaceIdForTests()
    const secondPassKeys = await new Promise<string[]>((resolveOpen, rejectOpen) => {
      const req = indexedDB.open(MIGRATION_DB, DB_VERSION + 1)
      req.onupgradeneeded = () => {
        const tx = req.transaction
        if (!tx) return
        tx.objectStore(WORKSPACES_STORE).put({ workspaceId: 'local' }, 'local')
        rekeyBrowserWorkspace(tx, () => {})
      }
      req.onsuccess = async () => {
        const db = req.result
        const keys = await new Promise<string[]>((resolveKeys, rejectKeys) => {
          const readTx = db.transaction(WORKSPACES_STORE, 'readonly')
          const keysReq = readTx.objectStore(WORKSPACES_STORE).getAllKeys()
          keysReq.onerror = () => rejectKeys(keysReq.error)
          readTx.oncomplete = () => resolveKeys(keysReq.result.map(String))
        })
        db.close()
        resolveOpen(keys)
      }
      req.onerror = () => rejectOpen(req.error)
    })

    // Asserted as a whole array, not `keys[0]`: a naive re-mint leaves the
    // OLD target row behind (nothing deletes it) alongside a fresh one, and
    // ULIDs sort roughly chronologically, so `keys[0]` after ascending
    // `getAllKeys()` would silently read back the correct-looking old id even
    // under that bug. Exactly one row, and it is the SAME one, is the real
    // invariant.
    expect(secondPassKeys).toEqual([firstUlid])
    const secondUlid = secondPassKeys[0] as string

    const remnants = await legacyLocalKeys()
    expect(remnants).toEqual({ workspaces: [], index: [], syncTree: [] })

    // The document is still reachable under the SAME id after both passes.
    // Read raw (not through `migratedLocal()`/`openWhiteboardDb`, both
    // pinned to `DB_VERSION`): this test forced the database past it with a
    // bare `indexedDB.open`, exactly as a genuine future migration bump
    // would in production — but unlike production, nothing here also moved
    // `DB_VERSION` forward, so the pinned opener would VersionError on it.
    const db = await openAtCurrentVersion(MIGRATION_DB)
    const rowsUnderSecondUlid = await new Promise<unknown[]>((resolveRows, rejectRows) => {
      const tx = db.transaction(DOCUMENT_INDEX_STORE, 'readonly')
      const range = IDBKeyRange.bound([secondUlid], [secondUlid, []])
      const req = tx.objectStore(DOCUMENT_INDEX_STORE).getAll(range)
      req.onerror = () => rejectRows(req.error)
      tx.oncomplete = () => {
        db.close()
        resolveRows(req.result)
      }
    })
    expect(rowsUnderSecondUlid).toEqual([
      expect.objectContaining({ documentId: V13_DOCUMENT_ID, workspaceId: secondUlid }),
    ])
  })

  it('fresh install: v0 -> 14 yields one ULID workspace, zero local rows', async () => {
    const ulid = await resolveBrowserWorkspaceId(MIGRATION_DB)
    expect(ulid).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(await migratedLocal().listDocuments()).toEqual([])

    const db = await openWhiteboardDb(MIGRATION_DB)
    const workspaceKeys = await new Promise<string[]>((resolveKeys, rejectKeys) => {
      const tx = db.transaction(WORKSPACES_STORE, 'readonly')
      const req = tx.objectStore(WORKSPACES_STORE).getAllKeys()
      req.onerror = () => rejectKeys(req.error)
      tx.oncomplete = () => {
        db.close()
        resolveKeys(req.result.map(String))
      }
    })
    expect(workspaceKeys).toEqual([ulid])
    expect(getBrowserWorkspaceId()).toBe(ulid)
  })
})

describe('IndexedDB v14 -> v15 (the browser workspace gets a segment)', () => {
  beforeEach(() => clearNamedDb(MIGRATION_DB))
  afterEach(() => clearNamedDb(MIGRATION_DB))

  it('current DB_VERSION is 15 or higher', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(15)
  })

  it('fresh install: the sole workspace row carries a segment that resolves', async () => {
    const ulid = await resolveBrowserWorkspaceId(MIGRATION_DB)
    const index = new IdbDocumentIndex(MIGRATION_DB)

    expect(await index.listWorkspaces()).toEqual([
      { workspaceId: ulid, segment: BROWSER_DEFAULT_SEGMENT },
    ])

    // The point of the slice, and not merely that a field is populated: the
    // workspace answers to the name a URL would carry. `resolveWorkspace` is
    // segment-first, so a row whose segment never landed answers `null` here
    // while still listing perfectly well.
    expect(await index.resolveWorkspace(BROWSER_DEFAULT_SEGMENT)).toEqual({
      workspaceId: ulid,
      segment: BROWSER_DEFAULT_SEGMENT,
    })
  })

  it('the minted segment is a legal one, not merely a string', () => {
    // A segment that fails its own schema would be rejected the moment the
    // URL layer parses it back, and this is the one segment nobody types.
    expect(workspaceSegmentSchema.safeParse(BROWSER_DEFAULT_SEGMENT).success).toBe(true)
  })

  it('a v13 database upgraded to head gets a segment beside its carried rows', async () => {
    const contentDoc = new Loro()
    contentDoc.getMovableList('elements').push('carried')
    await seedV13Fixture({
      documentId: V13_DOCUMENT_ID,
      path: 'carried-doc',
      contentSnapshot: contentDoc.export({ mode: 'snapshot' }),
    })

    const ulid = await resolveBrowserWorkspaceId(MIGRATION_DB)
    const index = new IdbDocumentIndex(MIGRATION_DB)
    expect(await index.listWorkspaces()).toEqual([
      { workspaceId: ulid, segment: BROWSER_DEFAULT_SEGMENT },
    ])

    // The carrier is ordered AFTER the re-key, and reads what it wrote. If it
    // ran first it would find no row, mint nothing, and still look green on
    // the fresh-install case above — so the document surviving beside the
    // segment is what says the ordering held.
    expect((await migratedLocal().listDocuments()).map((d) => d.documentId)).toEqual([
      V13_DOCUMENT_ID,
    ])
  })

  it('convergent: a segment already chosen is never overwritten by a later pass', async () => {
    await resolveBrowserWorkspaceId(MIGRATION_DB)
    const ulid = getBrowserWorkspaceId()

    // A rename is the whole reason this has to converge: the carrier re-runs
    // on EVERY future version bump (the chain has no memory of having run),
    // so a carrier that mints unconditionally would silently revert the name
    // its owner chose, one upgrade later.
    resetBrowserWorkspaceIdForTests()
    const stored = await new Promise<unknown>((resolveOpen, rejectOpen) => {
      const req = indexedDB.open(MIGRATION_DB, DB_VERSION + 1)
      req.onupgradeneeded = () => {
        const tx = req.transaction
        if (!tx) return
        tx.objectStore(WORKSPACES_STORE).put({ workspaceId: ulid, segment: 'work' }, ulid)
        mintBrowserWorkspaceSegment(tx, () => {})
      }
      req.onsuccess = async () => {
        const db = req.result
        const row = await new Promise<unknown>((resolveRow, rejectRow) => {
          const readTx = db.transaction(WORKSPACES_STORE, 'readonly')
          const rowReq = readTx.objectStore(WORKSPACES_STORE).get(ulid)
          rowReq.onerror = () => rejectRow(rowReq.error)
          readTx.oncomplete = () => resolveRow(rowReq.result)
        })
        db.close()
        resolveOpen(row)
      }
      req.onerror = () => rejectOpen(req.error)
    })

    expect(stored).toEqual({ workspaceId: ulid, segment: 'work' })
  })
})

describe('whiteboard IndexedDB v6 -> v7 upgrade (renames the container stores)', () => {
  beforeEach(() => clearNamedDb(MIGRATION_DB))
  afterEach(() => clearNamedDb(MIGRATION_DB))

  it('current DB_VERSION is 7 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(7)
  })

  it('moves every record to the renamed store and leaves no old store behind', async () => {
    const documentId = 'document-migrate-v7'
    const doc = new Loro()
    doc.getList('elements').push({ id: 'canonical-el' })
    await seedV6Fixture(documentId, doc.export({ mode: 'snapshot' }))

    const db = await openWhiteboardDb(MIGRATION_DB)
    // Read before asserting, and assert after: a failed expect() between the
    // open and the close would leak the connection, and every later test in
    // this file would then meet a database (() => clearNamedDb(MIGRATION_DB)) cannot delete.
    const storeNames = [...db.objectStoreNames].sort()
    // The old names are DELETED, not merely abandoned. A store left in place
    // would keep a second copy of every document readable by anything that
    // still remembers the old name.
    expect(storeNames).toEqual([
      'blobs',
      'contentTimestamps',
      'documentFiles',
      'documentIndex',
      'meta',
      'syncDocuments',
      'syncSnapshotChunks',
      'versionThumbnails',
      'versions',
      'workspaces',
    ])

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

    const metaStore = migratedLocal()
    // The row does not survive: v8 DISCARDS a document with no workspace and
    // no path, because there is nothing to migrate it to without inventing an
    // address, and an invented one is indistinguishable from a chosen one.
    // Everything a pre-path fixture holds therefore ends here — this migration
    // path converges on an empty document store, by decision, not by accident.
    expect(await migratedLocal().load(documentId)).toBeNull()
    expect(await metaStore.load(documentId)).toBeNull()
    expect(await metaStore.listDocuments()).toEqual([])
    // The bytes go with it rather than lingering as storage nothing names.
    expect((await (await loroStore()).load(documentId)).kind).toBe('not-found')
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
    expect(await migratedLocal().getDefaultDocumentId()).toBeNull()
  })

  it('is a no-op for a fresh install, which never had the old stores', async () => {
    const db = await openWhiteboardDb(MIGRATION_DB)
    expect([...db.objectStoreNames].sort()).toEqual([
      'blobs',
      'contentTimestamps',
      'documentFiles',
      'documentIndex',
      'meta',
      'syncDocuments',
      'syncSnapshotChunks',
      'versionThumbnails',
      'versions',
      'workspaces',
    ])
    db.close()
  })
})

describe('IndexedDB v5 -> v6 (removes reconnectKeypairs)', () => {
  const LEGACY_RECONNECT_SECRET_KEY = 'whiteboard.reconnect-secret.v1'

  beforeEach(() => clearNamedDb(MIGRATION_DB))
  afterEach(() => {
    localStorage.removeItem(LEGACY_RECONNECT_SECRET_KEY)
    return clearNamedDb(MIGRATION_DB)
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

    const db = await openWhiteboardDb(MIGRATION_DB)
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
    expect((await (await loroStore()).load(documentId)).kind).toBe('not-found')

    const metaStore = migratedLocal()
    // The row does not survive: v8 DISCARDS a document with no workspace and
    // no path, because there is nothing to migrate it to without inventing an
    // address, and an invented one is indistinguishable from a chosen one.
    // Everything a pre-path fixture holds therefore ends here — this migration
    // path converges on an empty document store, by decision, not by accident.
    expect(await migratedLocal().load(documentId)).toBeNull()
    expect(await metaStore.load(documentId)).toBeNull()
    expect(await metaStore.listDocuments()).toEqual([])

    // purgeLegacyReconnectCredentials() is exercised directly here (rather
    // than via a full App/router boot harness) — it is called unconditionally
    // at app boot in main.tsx; this test verifies the IndexedDB-side and
    // localStorage-side erasure are BOTH complete once a real app boot would
    // have run.
    purgeLegacyReconnectCredentials()
    expect(localStorage.getItem(LEGACY_RECONNECT_SECRET_KEY)).toBeNull()
  })

  it('a fresh install at the current version never creates reconnectKeypairs', async () => {
    const db = await openWhiteboardDb(MIGRATION_DB)
    expect(db.objectStoreNames.contains('reconnectKeypairs')).toBe(false)
    expect([...db.objectStoreNames].sort()).toEqual([
      'blobs',
      'contentTimestamps',
      'documentFiles',
      'documentIndex',
      'meta',
      'syncDocuments',
      'syncSnapshotChunks',
      'versionThumbnails',
      'versions',
      'workspaces',
    ])
    db.close()
  })
})

describe('IndexedDB v4 -> v5', () => {
  beforeEach(() => clearNamedDb(MIGRATION_DB))
  afterEach(() => clearNamedDb(MIGRATION_DB))

  it('current DB_VERSION is 5 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(5)
  })

  it('opening a v4 database at the current version preserves every other store', async () => {
    const documentId = 'canvas-migrate-v5'
    const doc = new Loro()
    doc.getList('elements').push({ id: 'canonical-el' })
    const loroSnapshot = doc.export({ mode: 'snapshot' })
    await seedV4Fixture(documentId, loroSnapshot)

    const db = await openWhiteboardDb(MIGRATION_DB)
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
    expect((await (await loroStore()).load(documentId)).kind).toBe('not-found')

    const metaStore = migratedLocal()
    // The row does not survive: v8 DISCARDS a document with no workspace and
    // no path, because there is nothing to migrate it to without inventing an
    // address, and an invented one is indistinguishable from a chosen one.
    // Everything a pre-path fixture holds therefore ends here — this migration
    // path converges on an empty document store, by decision, not by accident.
    expect(await migratedLocal().load(documentId)).toBeNull()
    expect(await metaStore.load(documentId)).toBeNull()
    expect(await metaStore.listDocuments()).toEqual([])
  })
})

describe('whiteboard IndexedDB v3 -> v4 upgrade', () => {
  beforeEach(() => clearNamedDb(MIGRATION_DB))
  afterEach(() => clearNamedDb(MIGRATION_DB))

  it('current DB_VERSION is 4 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(4)
  })

  it('opening a v3 database at v4 creates canvasFiles and preserves existing loroCanvases/documents/meta contents', async () => {
    const documentId = 'canvas-migrate-v4'
    const doc = new Loro()
    doc.getList('elements').push({ id: 'canonical-el' })
    const loroSnapshot = doc.export({ mode: 'snapshot' })
    await seedV3Fixture(documentId, loroSnapshot)

    const db = await openWhiteboardDb(MIGRATION_DB)
    expect(db.objectStoreNames.contains('documentFiles')).toBe(true)
    db.close()

    // Discarded with its document — see the note below.
    expect((await (await loroStore()).load(documentId)).kind).toBe('not-found')

    const metaStore = migratedLocal()
    // The row does not survive: v8 DISCARDS a document with no workspace and
    // no path, because there is nothing to migrate it to without inventing an
    // address, and an invented one is indistinguishable from a chosen one.
    // Everything a pre-path fixture holds therefore ends here — this migration
    // path converges on an empty document store, by decision, not by accident.
    expect(await migratedLocal().load(documentId)).toBeNull()
    expect(await metaStore.load(documentId)).toBeNull()
    expect(await metaStore.listDocuments()).toEqual([])
  })
})

describe('whiteboard IndexedDB v2 -> v3 upgrade', () => {
  beforeEach(() => clearNamedDb(MIGRATION_DB))
  afterEach(() => clearNamedDb(MIGRATION_DB))

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
    const db = await openWhiteboardDb(MIGRATION_DB)
    db.close()

    // (b) Nothing else survives. A v2 row carries no workspace and no path —
    // and could not, they did not exist — so v8 discards it along with its
    // Loro record. What the pre-v3 `scene` strip did to this row on the way
    // through is no longer observable; the guard that it must not THROW on a
    // corrupt row still is, and is the next test.
    const metaStore = migratedLocal()
    expect(await migratedLocal().load(documentId)).toBeNull()
    expect(await metaStore.load(documentId)).toBeNull()
    expect(await metaStore.listDocuments()).toEqual([])
    expect((await (await loroStore()).load(documentId)).kind).toBe('not-found')
    expect(await migratedLocal().getDefaultDocumentId()).toBeNull()
  })

  it('upgrades without aborting when a legacy canvases row is a non-object (corrupt data)', async () => {
    // A null / non-object row must not throw a TypeError from `'scene' in value`
    // inside the upgrade cursor — that would abort the transaction and brick the
    // DB open for the user.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(MIGRATION_DB, 2)
      req.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
        if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
        if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
      }
      req.onsuccess = () => {
        const db = req.result
        letFixtureStepAside(db)
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
    const db = await openWhiteboardDb(MIGRATION_DB)
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
      const req = indexedDB.open(MIGRATION_DB, 2)
      req.onsuccess = () => {
        letFixtureStepAside(req.result)
        resolve(req.result)
      }
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
  /** A hand-written `loroDocuments` envelope, for the v12 carry. */
  loroRecord?: readonly [key: string, value: unknown]
  defaultDocumentId?: string
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MIGRATION_DB, 7)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      for (const name of ['meta', 'documents', 'loroDocuments', 'documentFiles']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
      }
    }
    req.onsuccess = () => {
      const db = req.result
      letFixtureStepAside(db)
      const tx = db.transaction(['meta', 'documents', 'loroDocuments'], 'readwrite')
      if (rows.defaultDocumentId !== undefined) {
        tx.objectStore('meta').put(rows.defaultDocumentId, 'defaultDocumentId')
      }
      for (const [key, value] of rows.documents) tx.objectStore('documents').put(value, key)
      if (rows.loroRecord) {
        tx.objectStore('loroDocuments').put(rows.loroRecord[1], rows.loroRecord[0])
      }
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
  const db = await openWhiteboardDb(MIGRATION_DB)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readonly')
    const req = tx.objectStore(name).getAllKeys()
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => {
      db.close()
      resolve(req.result as string[])
    }
  })
}

const POST_PATH_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const PRE_PATH_ID = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6'

describe('whiteboard IndexedDB v7 -> v8 upgrade (discards pre-path documents)', () => {
  beforeEach(() => clearNamedDb(MIGRATION_DB))
  afterEach(() => clearNamedDb(MIGRATION_DB))

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

    expect(await migratedLocal().listDocuments()).toEqual([])
    // The bytes go too: a Loro record no document names is unreachable
    // storage that nothing would ever clean up.
    expect(await storeKeys(SYNC_DOCUMENTS_STORE)).toEqual([])
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

    // `workspaceId` is the one field that changes: the seeded row still
    // spells the pre-rekey `'local'` (that is the v7 shape this fixture is
    // pinning), but `listDocuments()` reads it back through the v14+ index,
    // which reports the canonical id the rekey moved it onto.
    expect(await migratedLocal().listDocuments()).toEqual([
      {
        ...row,
        workspaceId: await resolveBrowserWorkspaceId(MIGRATION_DB),
        updatedAt: expect.any(String),
      },
    ])
    expect(await storeKeys(SYNC_DOCUMENTS_STORE)).toEqual([`document:${POST_PATH_ID}`])
    expect(await migratedLocal().getDefaultDocumentId()).toBe(POST_PATH_ID)
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

    expect((await migratedLocal().listDocuments()).map((d) => d.documentId)).toEqual([POST_PATH_ID])
    expect(await storeKeys(SYNC_DOCUMENTS_STORE)).toEqual([`document:${POST_PATH_ID}`])
    expect(await migratedLocal().getDefaultDocumentId()).toBe(POST_PATH_ID)
  })

  it('survives a corrupt (non-object) row rather than aborting the whole upgrade', async () => {
    await seedV7Fixture({ documents: [['junk', 42]], loro: ['junk'] })
    expect(await migratedLocal().listDocuments()).toEqual([])
  })
})

describe('v6 -> v8 in one upgrade (the discard must see what the v7 copy produced)', () => {
  beforeEach(() => clearNamedDb(MIGRATION_DB))
  afterEach(() => clearNamedDb(MIGRATION_DB))

  it('discards a pre-path row that arrives in `documents` via the v7 rename copy', async () => {
    // The two passes share ONE versionchange transaction: the rename copies
    // `canvases` -> `documents` through a cursor whose puts land in its own
    // callbacks, and the discard walks `documents`. A discard cursor opened
    // before those puts have run sees an empty store and deletes nothing —
    // which looks exactly like a successful upgrade.
    const doc = new Loro()
    doc.getList('elements').push({ id: 'el' })
    await seedV6Fixture('pre-path-v6', doc.export({ mode: 'snapshot' }))

    expect(await migratedLocal().listDocuments()).toEqual([])
    expect(await storeKeys(SYNC_DOCUMENTS_STORE)).toEqual([])
  })
})

describe('cross-tab upgrades', () => {
  beforeEach(() => clearNamedDb(MIGRATION_DB))
  afterEach(() => clearNamedDb(MIGRATION_DB))

  it('an open connection closes itself so a newer version is not blocked behind it', async () => {
    // Stands in for the second tab: a connection this module handed out and
    // that nobody closed. Without `onversionchange` it holds the database at
    // its own version and the upgrade below never fires — the request sits in
    // `blocked` forever, which in the app is an editor that never loads and
    // no error to explain why.
    const idle = await openWhiteboardDb(MIGRATION_DB)

    let blocked = false
    const upgraded = await new Promise<boolean>((resolve) => {
      const req = indexedDB.open(MIGRATION_DB, DB_VERSION + 1)
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

  // Deterministic, unlike the CI failure it explains: the fixture connection is
  // deliberately left open at an old version, so no scheduling luck is
  // involved. With the manners `letFixtureStepAside` gives it, the upgrade
  // below goes through; without them it is blocked, which is exactly what CI
  // kept reporting against unrelated tests.
  it('is not blocked by a fixture connection left open at an older version', async () => {
    const held = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(MIGRATION_DB, DB_VERSION - 1)
      req.onsuccess = () => {
        letFixtureStepAside(req.result)
        resolve(req.result)
      }
      req.onerror = () => reject(req.error)
    })

    try {
      const db = await openWhiteboardDb(MIGRATION_DB)
      expect(db.version).toBe(DB_VERSION)
      db.close()
    } finally {
      held.close()
    }
  })

  it('rejects with a message a caller can show when a connection that will NOT self-close holds the old version', async () => {
    // The other half, and the one the self-close cannot cover: a tab still
    // running a pre-v8 bundle has no `onversionchange` handler, so it sits on
    // the old version until a person closes it. Without this branch the open
    // request never settles, and every caller — the store, the Loro store, the
    // file store — awaits a promise that has no outcome, which in the app is an
    // editor that never loads with nothing on screen to explain why.
    const stubborn = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(MIGRATION_DB, DB_VERSION - 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

    try {
      // Raced against a short deadline on purpose. Without the branch the open
      // request never settles at all, and an unbounded await would spend the
      // whole per-test timeout (measured: 120s) reporting the same thing this
      // says in three.
      const outcome = await Promise.race([
        openWhiteboardDb(MIGRATION_DB).then(
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
      await clearNamedDb(MIGRATION_DB)
    }
  })
})

describe('IndexedDB v9 -> v10 (backfills the index)', () => {
  beforeEach(() => clearNamedDb(MIGRATION_DB))
  afterEach(() => clearNamedDb(MIGRATION_DB))

  it('carries every surviving document into the index', async () => {
    // v9 added the index stores EMPTY and said the bespoke `documents` store
    // would keep serving reads "until its call sites move". They have moved,
    // and nothing else reads `documents` any more — so without this backfill
    // an upgrading user opens the app to an empty list with their bytes still
    // on disk, which is the worst shape a data loss can take.
    await seedV7Fixture({
      documents: [
        [
          POST_PATH_ID,
          {
            documentId: POST_PATH_ID,
            workspaceId: 'local',
            path: 'design/login',
            name: 'Login',
            updatedAt: '2026-01-01T00:00:00.000Z',
            kind: 'spatial',
          },
        ],
      ],
      loro: [POST_PATH_ID],
      defaultDocumentId: POST_PATH_ID,
    })

    const local = migratedLocal()
    expect(await local.listDocuments()).toEqual([
      {
        documentId: POST_PATH_ID,
        // Reported through the v14+ index: the canonical id, not the seeded
        // pre-rekey `'local'` literal (see the comment on the previous test).
        workspaceId: await resolveBrowserWorkspaceId(MIGRATION_DB),
        path: 'design/login',
        name: 'Login',
        // The content record's stamp ('x', what the fixture wrote there), not
        // the discarded row's own `updatedAt`. That field was written on
        // create and rename and never on an edit, so carrying it forward
        // would migrate a wrong answer into the new shape.
        updatedAt: 'x',
        kind: 'spatial',
      },
    ])
    expect(await migratedLocal().getDefaultDocumentId()).toBe(POST_PATH_ID)
  })

  it('creates the workspace even with no documents to carry', async () => {
    // The port distinguishes an absent workspace from an empty one, and the
    // page shows that difference as "Failed to load documents from this
    // browser." A user who had nothing to migrate must still land on an
    // empty state.
    await seedV7Fixture({ documents: [] })
    expect(await migratedLocal().listDocuments()).toEqual([])
  })
})

describe('IndexedDB v11 -> v12 (carries content to the port)', () => {
  beforeEach(() => clearNamedDb(MIGRATION_DB))
  afterEach(() => clearNamedDb(MIGRATION_DB))

  it('carries a snapshot, its log and its timestamp across', async () => {
    // The whole point of the version: content moves to the `DocumentStore`
    // port's store, and the last-write time to its own. A document left
    // behind here is a document that opens empty.
    const doc = new Loro()
    doc.getMovableList('elements').push('one')
    doc.commit()
    const snapshot = doc.export({ mode: 'snapshot' })
    const before = doc.version()
    doc.getMovableList('elements').push('two')
    doc.commit()
    const delta = doc.export({ mode: 'update', from: before })

    await seedV7Fixture({
      documents: [
        [
          POST_PATH_ID,
          {
            documentId: POST_PATH_ID,
            workspaceId: 'local',
            path: 'carried',
            name: 'Carried',
            updatedAt: 'ignored',
            kind: 'spatial',
          },
        ],
      ],
      loroRecord: [
        POST_PATH_ID,
        { v: 1, snapshot, updatedAt: '2026-08-01T00:00:00.000Z', deltas: [delta] },
      ],
    })

    const store = await loroStore()
    const loaded = await store.load(POST_PATH_ID)
    expect(loaded.kind).toBe('ok')
    if (loaded.kind === 'ok') {
      expect([...loaded.snapshot]).toEqual([...snapshot])
      // The log travels too: without it the document silently rolls back to
      // whatever its last snapshot held.
      expect(loaded.deltas?.length).toBe(1)
    }
    const stamps = await idbContentClock(MIGRATION_DB)([POST_PATH_ID])
    expect(stamps.get(POST_PATH_ID)).toBe('2026-08-01T00:00:00.000Z')
  })

  it('carries a record it cannot parse instead of destroying it', async () => {
    // The migration deletes `loroDocuments` at the end of its walk, so a
    // record it skips is a record it DESTROYS. Both things that reach this
    // path — an envelope from a newer build, and a damaged one — are answers
    // `loadSnapshot` can still give ("unreadable"), and that is recoverable
    // where "gone" is not.
    await seedV7Fixture({
      documents: [],
      loroRecord: [POST_PATH_ID, { v: 99, fromTheFuture: true }],
    })

    const result = await (await loroStore()).load(POST_PATH_ID)
    expect(result.kind).toBe('unsupported-version')
  })

  it('drops the old store rather than leaving a second copy', async () => {
    await seedV7Fixture({ documents: [] })
    const db = await openWhiteboardDb(MIGRATION_DB)
    const names = [...db.objectStoreNames]
    db.close()
    expect(names).not.toContain('loroDocuments')
  })
})
