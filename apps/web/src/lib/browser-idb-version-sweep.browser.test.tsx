/**
 * The bound on v19's version sweep, which is the whole correctness of it.
 *
 * Every other step in the upgrade handler is idempotent — "create it if
 * absent", "delete it if present". The sweep is not: run again on a database
 * already at v19, it would empty a `versions` store whose rows are by then
 * exactly the ones the content digest was added to keep. The v18 -> v19 half
 * (that it does sweep) is in `browser-idb-migration.browser.test.tsx`; this
 * file is the half that says it stops, at the boundary itself.
 *
 * Real-browser mode for the same reason as that file: the upgrade runs inside
 * a genuine `versionchange` transaction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import {
  DB_VERSION,
  DOCUMENT_INDEX_STORE,
  openWhiteboardDb,
  SYNC_DOCUMENTS_STORE,
  SYNC_SNAPSHOT_CHUNKS_STORE,
  sweepVersionsWrittenBeforeDigests,
  VERSION_DIGEST_DB_VERSION,
  VERSIONS_BY_DOCUMENT_INDEX,
  VERSIONS_STORE,
  WORKSPACES_STORE,
} from './browser-idb.js'

/** This file's own database: it parks one at an old version, so it must not be the shared one. */
const SWEEP_DB = 'whiteboard-version-sweep-test'

/** A point written the way v19 writes them: it carries the digest of its content. */
const DIGEST_ROW = {
  id: 'v-digest',
  workspaceId: 'ws-1',
  documentId: 'doc-1',
  path: 'canvas-a',
  createdAt: 1,
  elementCount: 1,
  contentDigest: 'a1b2c3d4e5f60718',
  frontiers: new Uint8Array([1, 2, 3]),
}

/** A database at the sweep's own version, holding one digest-carrying point. */
async function seedAtDigestVersion(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SWEEP_DB, VERSION_DIGEST_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of [
        'meta',
        WORKSPACES_STORE,
        SYNC_DOCUMENTS_STORE,
        SYNC_SNAPSHOT_CHUNKS_STORE,
        'documentFiles',
        'blobs',
        'contentTimestamps',
      ]) {
        db.createObjectStore(name)
      }
      const index = db.createObjectStore(DOCUMENT_INDEX_STORE, { keyPath: ['workspaceId', 'path'] })
      index.createIndex('byId', ['workspaceId', 'documentId'], { unique: true })
      const versions = db.createObjectStore(VERSIONS_STORE, { keyPath: 'id' })
      versions.createIndex(VERSIONS_BY_DOCUMENT_INDEX, ['workspaceId', 'documentId'])
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => db.close()
      const tx = db.transaction([WORKSPACES_STORE, VERSIONS_STORE], 'readwrite')
      tx.objectStore(WORKSPACES_STORE).put({ workspaceId: 'ws-1' }, 'ws-1')
      tx.objectStore(VERSIONS_STORE).put(DIGEST_ROW)
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
    }
    req.onerror = () => reject(req.error)
  })
}

/** The `versions` store's keys, read at whatever version the database is now. */
async function versionIds(version?: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SWEEP_DB, version)
    req.onupgradeneeded = () => {
      const tx = req.transaction
      // The REAL sweep, in a genuine versionchange transaction, told the
      // version this database is upgrading from — the boundary itself.
      if (tx) sweepVersionsWrittenBeforeDigests(tx, VERSION_DIGEST_DB_VERSION)
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(VERSIONS_STORE, 'readonly')
      const keys = tx.objectStore(VERSIONS_STORE).getAllKeys()
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
      tx.oncomplete = () => {
        db.close()
        resolve(keys.result.map(String))
      }
    }
    req.onerror = () => reject(req.error)
  })
}

describe('the v19 version sweep stops at its own version', () => {
  beforeEach(() => clearNamedDb(SWEEP_DB))
  afterEach(() => clearNamedDb(SWEEP_DB))

  it('is the version before head, so a real upgrade crosses the boundary', () => {
    expect(VERSION_DIGEST_DB_VERSION).toBeLessThan(DB_VERSION)
  })

  it('keeps the points a v19 database wrote through the upgrade to head', async () => {
    await seedAtDigestVersion()
    // A probe, so "kept" cannot be satisfied by a fixture that never wrote one.
    expect(await versionIds()).toEqual([DIGEST_ROW.id])

    const db = await openWhiteboardDb(SWEEP_DB)
    db.close()

    expect(await versionIds()).toEqual([DIGEST_ROW.id])
  })

  it('leaves them when told directly it is upgrading from v19', async () => {
    await seedAtDigestVersion()
    expect(await versionIds(VERSION_DIGEST_DB_VERSION + 1)).toEqual([DIGEST_ROW.id])
  })
})
