/**
 * The demote deletion's own contract, at the function level — the section's
 * flow tests share one IndexedDB across a whole file, so the registry there
 * is never empty and the last-workspace mint could rot unobserved (measured:
 * dropping the mint survived the flow suite).
 */
import {
  readTrashEntries,
  readWorkspaceDocuments,
  recordTrashEntry,
  writeDocumentKind,
} from '@kamiazya/whiteboard-loro-adapter'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { idbContentClock } from './browser-document-summary.js'
import { BROWSER_DEFAULT_SEGMENT, openWhiteboardDb, WORKSPACES_STORE } from './browser-idb.js'
import { BrowserVersionStore, savedVersionRows } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import {
  getBrowserWorkspaceId,
  resetBrowserWorkspaceIdForTests,
  resolveBrowserWorkspaceId,
} from './browser-workspace-id.js'
import { demoteBrowserWorkspace, replicaCarriesAll } from './demote-browser-workspace.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { touchContentTimestamp } from './loro-store.js'

claimIsolatedWhiteboardDb('demote-browser-workspace')

async function registryRows(): Promise<string[]> {
  const db = await openWhiteboardDb()
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const req = db.transaction([WORKSPACES_STORE]).objectStore(WORKSPACES_STORE).getAllKeys()
      req.onsuccess = () => resolve(req.result.map(String))
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

describe('demoteBrowserWorkspace', () => {
  beforeEach(() => {
    // The shared setup may have resolved the identity against another
    // database; this file's claims are about ITS isolated one.
    resetBrowserWorkspaceIdForTests()
  })

  it('deleting the last workspace mints a fresh empty one and re-points the identity', async () => {
    const sourceId = await resolveBrowserWorkspaceId()
    const docs = new BrowserWorkspaceDocs()
    await docs.create(sourceId)
    expect(await registryRows()).toEqual([sourceId])

    await demoteBrowserWorkspace(sourceId)

    expect(await docs.open(sourceId)).toBeNull()
    const rows = await registryRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toBe(sourceId)
    // The in-memory identity followed, so a racing write cannot resurrect
    // the deleted record under its old id.
    expect(getBrowserWorkspaceId()).toBe(rows[0])
    // The fresh row carries the default segment, so addresses keep a name.
    const db = await openWhiteboardDb()
    try {
      const row = await new Promise<{ segment?: string }>((resolve, reject) => {
        const req = db
          .transaction([WORKSPACES_STORE])
          .objectStore(WORKSPACES_STORE)
          .get(rows[0] as string)
        req.onsuccess = () => resolve(req.result as { segment?: string })
        req.onerror = () => reject(req.error)
      })
      expect(row.segment).toBe(BROWSER_DEFAULT_SEGMENT)
    } finally {
      db.close()
    }
  })
})

/**
 * A workspace with one saved version and one trashed document, beside a
 * neighbouring workspace that has a saved version of its own.
 */
async function seedTwoWorkspaces() {
  const index = new FoldingBrowserIndex()
  const docs = new BrowserWorkspaceDocs()
  const versions = new BrowserVersionStore({ docs, index })
  const sourceId = await resolveBrowserWorkspaceId()
  await index.createWorkspace({ workspaceId: sourceId })
  const sketch = await index.createDocument({
    workspaceId: sourceId,
    path: 'sketch',
    kind: 'spatial',
  })
  const gone = await index.createDocument({ workspaceId: sourceId, path: 'gone', kind: 'spatial' })
  await versions.save(sourceId, 'sketch', { label: 'as drafted' })
  await index.deleteDocument({ workspaceId: sourceId, path: 'gone' })
  const neighbourId = 'ws-neighbour'
  await index.createWorkspace({ workspaceId: neighbourId })
  const kept = await index.createDocument({
    workspaceId: neighbourId,
    path: 'kept',
    kind: 'spatial',
  })
  await versions.save(neighbourId, 'kept', { label: 'neighbour' })
  for (const id of [sketch.documentId, gone.documentId, kept.documentId]) {
    await touchContentTimestamp(id)
  }
  const record = await docs.open(sourceId)
  const entry = record === null ? undefined : readTrashEntries(record)[0]
  if (entry === undefined) throw new Error('the seed trashed nothing')
  return { docs, sourceId, neighbourId, sketch, gone, kept, entry }
}

describe('demoteBrowserWorkspace, what the old record named', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    resetBrowserWorkspaceIdForTests()
  })

  it("deletes its trash bytes, saved versions and listing clocks, and no neighbour's", async () => {
    const { sourceId, neighbourId, sketch, gone, kept, entry } = await seedTwoWorkspaces()
    const blobs = new IdbBlobStore()
    expect(await blobs.get({ ref: entry.blob })).not.toBeNull()
    expect(await savedVersionRows(sourceId)).toHaveLength(1)

    await demoteBrowserWorkspace(sourceId)

    expect(await blobs.get({ ref: entry.blob })).toBeNull()
    expect(await savedVersionRows(sourceId)).toEqual([])
    expect(await savedVersionRows(neighbourId)).toHaveLength(1)
    const stamps = await idbContentClock()([sketch.documentId, gone.documentId, kept.documentId])
    expect([...stamps.keys()]).toEqual([kept.documentId])
  })

  it("keeps trash bytes another workspace's trash still names", async () => {
    const { docs, sourceId, neighbourId, kept, entry } = await seedTwoWorkspaces()
    const neighbour = await docs.open(neighbourId)
    if (neighbour === null) throw new Error('the neighbour has no record')
    recordTrashEntry(neighbour, { ...entry, documentId: kept.documentId })
    await docs.save(neighbourId, neighbour)

    await demoteBrowserWorkspace(sourceId)

    expect(await new IdbBlobStore().get({ ref: entry.blob })).not.toBeNull()
  })
})

describe('replicaCarriesAll', () => {
  it('a missing replica record carries nothing', async () => {
    expect(
      await replicaCarriesAll(new BrowserWorkspaceDocs(), 'ws-absent', [
        '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      ]),
    ).toBe(false)
  })

  it('answers by membership of every promoted id', async () => {
    const docs = new BrowserWorkspaceDocs()
    const record = await docs.create('ws-replica')
    // A record with no documents: ids are absent, so nothing is carried.
    writeDocumentKind(record, 'markdown')
    await docs.save('ws-replica', record)
    expect(readWorkspaceDocuments(record)).toEqual([])
    expect(await replicaCarriesAll(docs, 'ws-replica', ['01ARZ3NDEKTSV4RRFFQ69G5FAV'])).toBe(false)
    expect(await replicaCarriesAll(docs, 'ws-replica', [])).toBe(true)
  })
})
