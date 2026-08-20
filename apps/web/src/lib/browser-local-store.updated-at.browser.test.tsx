/**
 * `updatedAt` has to mean "when this document last changed", because that is
 * what the list sorts by and what "Xd ago" says. The metadata row's copy is
 * written at create and at rename only — nothing bumps it when the CONTENT
 * changes — so a document edited for an hour reported its creation time, and
 * the staleness stamp `useDocumentFileSeams` reads never moved.
 *
 * Real IndexedDB, because the fix is a join across two object stores and a
 * fake that returns whatever it was handed would not exercise it — but its OWN
 * database, not the app's. Browser tests share an origin, so deleting
 * `whiteboard` between cases tears it out from under whatever other file is
 * mid-fixture, and the failure lands there. Measured: it did exactly that to
 * `browser-idb-migration.browser.test.tsx`, twice.
 */
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IndexedDBStore, LOCAL_WORKSPACE_ID } from './browser-local-store.js'
import { LoroStore } from './loro-store.js'

const DB_NAME = 'whiteboard-updated-at-test'
const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const CREATED_AT = '2026-01-01T00:00:00.000Z'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

async function seedDocument(): Promise<void> {
  const store = new IndexedDBStore(DB_NAME)
  await store.save({
    documentId: DOCUMENT_ID,
    workspaceId: LOCAL_WORKSPACE_ID,
    path: 'notes',
    name: 'Notes',
    updatedAt: CREATED_AT,
    kind: 'spatial',
  })
}

/** One real content write, which is what stamps the Loro record. */
async function editContent(): Promise<void> {
  const doc = new Loro()
  doc.getList('elements').push({ id: 'el' })
  await new LoroStore(DB_NAME).save(DOCUMENT_ID, doc.export({ mode: 'snapshot' }))
}

describe('updatedAt reflects the last CONTENT change', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('moves after an edit, in the list the user sorts by', async () => {
    await seedDocument()
    await editContent()

    const [listed] = await new IndexedDBStore(DB_NAME).listDocuments()
    expect(listed?.updatedAt).not.toBe(CREATED_AT)
    // Not merely "different": it has to be LATER, or a sort by it is wrong in
    // a way no equality check would catch.
    expect(listed?.updatedAt.localeCompare(CREATED_AT)).toBeGreaterThan(0)
  })

  it('moves for a single document read, which is the staleness stamp', async () => {
    await seedDocument()
    await editContent()

    const result = await new IndexedDBStore(DB_NAME).load(DOCUMENT_ID)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.snapshot.updatedAt.localeCompare(CREATED_AT)).toBeGreaterThan(0)
  })

  it('keeps the metadata time for a document whose content was never written', async () => {
    // A document created but never edited has no Loro record. Its own
    // timestamp is the only one there is, and inventing "now" for it would
    // make every fresh document look edited.
    await seedDocument()

    const [listed] = await new IndexedDBStore(DB_NAME).listDocuments()
    expect(listed?.updatedAt).toBe(CREATED_AT)
  })
})
