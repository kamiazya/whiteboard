/**
 * The one baseline schema: what a fresh install creates, and what an older
 * database gets instead of an upgrade — a refusal by name that leaves it
 * exactly as it was.
 *
 * Real-browser mode: a version change, its abort and what it rolls back are
 * IndexedDB semantics fake-indexeddb only approximates.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import {
  BROWSER_DEFAULT_SEGMENT,
  DB_VERSION,
  openWhiteboardDb,
  WORKSPACES_STORE,
} from './browser-idb.js'

/** This file's own database: it parks one at an old version, so it must not be the shared one. */
const DB = 'whiteboard-baseline-test'

/** What the baseline holds, spelled out so a store added or lost is a decision this file sees. */
const BASELINE = [
  'blobs',
  'contentTimestamps',
  'documentFiles',
  'documentIndex',
  'meta',
  'syncDocuments',
  'syncSnapshotChunks',
  'versions',
  'workspaces',
]

/** A database an older build left: version `version`, one store, one record in it. */
async function seedOlder(version: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, version)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(WORKSPACES_STORE)
      req.transaction?.objectStore(WORKSPACES_STORE).put({ workspaceId: 'local' }, 'local')
    }
    req.onsuccess = () => {
      req.result.close()
      resolve()
    }
    req.onerror = () => reject(req.error)
  })
}

/** The version and the workspace keys a database holds, read without upgrading it. */
async function inspect(): Promise<{ version: number; workspaces: string[] }> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB)
    req.onsuccess = () => {
      const db = req.result
      const keys = db.transaction(WORKSPACES_STORE).objectStore(WORKSPACES_STORE).getAllKeys()
      keys.onsuccess = () => {
        db.close()
        resolve({ version: db.version, workspaces: keys.result.map(String) })
      }
      keys.onerror = () => reject(keys.error)
    }
    req.onerror = () => reject(req.error)
  })
}

describe('the browser database baseline', () => {
  beforeEach(() => clearNamedDb(DB))
  afterEach(() => clearNamedDb(DB))

  it('creates every baseline store and the default workspace on a fresh install', async () => {
    const db = await openWhiteboardDb(DB)
    try {
      expect(db.version).toBe(DB_VERSION)
      expect([...db.objectStoreNames].sort()).toEqual(BASELINE)
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction(WORKSPACES_STORE).objectStore(WORKSPACES_STORE).getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ segment: BROWSER_DEFAULT_SEGMENT })
      expect((rows[0] as { workspaceId: string }).workspaceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    } finally {
      db.close()
    }
  })

  it.each([
    1,
    13,
    DB_VERSION - 1,
  ])('refuses a database at version %i by name, and leaves it as it was', async (version) => {
    await seedOlder(version)
    await expect(openWhiteboardDb(DB)).rejects.toMatchObject({
      name: 'BrowserStorageRefusedError',
      reason: 'database-version',
    })
    expect(await inspect()).toEqual({ version, workspaces: ['local'] })
  })
})
