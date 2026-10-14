/**
 * The demote deletion's own contract, at the function level — the section's
 * flow tests share one IndexedDB across a whole file, so the registry there
 * is never empty and the last-workspace mint could rot unobserved (measured:
 * dropping the mint survived the flow suite).
 */
import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  documentContainers,
  readTrashEntries,
  readWorkspaceDocuments,
  recordTrashEntry,
  resolveWorkspaceDocumentById,
  writeDocumentKind,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { chunkSnapshot, DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { expectLoggedFailures } from '../test-utils/browser-setup.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserBackend } from './browser-backend.js'
import { idbContentClock } from './browser-document-summary.js'
import { BROWSER_DEFAULT_SEGMENT, openWhiteboardDb, WORKSPACES_STORE } from './browser-idb.js'
import { BrowserVersionStore, savedVersionRows } from './browser-version-store.js'
import { BrowserWorkspaceDocs, saveAndAnnounce } from './browser-workspace-docs.js'
import {
  getBrowserWorkspaceId,
  resetBrowserWorkspaceIdForTests,
  resolveBrowserWorkspaceId,
} from './browser-workspace-id.js'
import { demoteBrowserWorkspace, replicaCarriesAll } from './demote-browser-workspace.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { touchContentTimestamp } from './loro-store.js'
import { openDocumentStore } from './replica-store.js'
import { isWorkspaceRemovedError } from './workspace-tombstone.js'

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
    // The fresh row carries the default segment, so addresses keep a name —
    // read through the registry's own reader, whose schema drops a key it
    // does not know rather than failing, so the writer's spelling alone
    // proves nothing.
    expect(await new IdbDocumentIndex().listWorkspaces()).toEqual([
      { workspaceId: rows[0], segment: BROWSER_DEFAULT_SEGMENT },
    ])
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

  it('re-points the identity at a remaining workspace and mints none', async () => {
    const { sourceId, neighbourId } = await seedTwoWorkspaces()

    await demoteBrowserWorkspace(sourceId)

    expect(await registryRows()).toEqual([neighbourId])
    expect(getBrowserWorkspaceId()).toBe(neighbourId)
  })
})

describe('demoteBrowserWorkspace, beside a neighbour that will not open', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    resetBrowserWorkspaceIdForTests()
  })

  it('still deletes the versions and clocks, and keeps only the trash bytes', async () => {
    const { sourceId, sketch, gone, entry } = await seedTwoWorkspaces()
    // A registered neighbour whose record is bytes Loro will not import:
    // what its trash names is unknown, so no trash blob may go.
    await new FoldingBrowserIndex().createWorkspace({ workspaceId: 'ws-unreadable' })
    const garbage = chunkSnapshot(new Uint8Array([1, 2, 3, 4]), DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES)
    await openDocumentStore().saveSnapshot({
      docRef: { kind: 'workspace-tree', workspaceId: 'ws-unreadable' },
      ...garbage,
      frontier: new Uint8Array(),
    })
    const logged = expectLoggedFailures()

    await demoteBrowserWorkspace(sourceId)

    expect(await savedVersionRows(sourceId)).toEqual([])
    const stamps = await idbContentClock()([sketch.documentId, gone.documentId])
    expect([...stamps.keys()]).toEqual([])
    expect(await new IdbBlobStore().get({ ref: entry.blob })).not.toBeNull()
    expect(logged.join('\n')).toContain('trash blobs')
  })
})

describe('demoteBrowserWorkspace, a moved record that will not open', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    resetBrowserWorkspaceIdForTests()
  })

  it('still deletes its saved versions, and says what it left', async () => {
    const { sourceId, neighbourId, entry } = await seedTwoWorkspaces()
    const garbage = chunkSnapshot(new Uint8Array([1, 2, 3, 4]), DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES)
    await openDocumentStore().saveSnapshot({
      docRef: { kind: 'workspace-tree', workspaceId: sourceId },
      ...garbage,
      frontier: new Uint8Array(),
    })
    const logged = expectLoggedFailures()

    await demoteBrowserWorkspace(sourceId)

    expect(await savedVersionRows(sourceId)).toEqual([])
    expect(await savedVersionRows(neighbourId)).toHaveLength(1)
    // What only the record could name is unjudgeable, so it stays — and is said.
    expect(await new IdbBlobStore().get({ ref: entry.blob })).not.toBeNull()
    expect(logged.join('\n')).toContain('could not be read')
  })
})

describe('demoteBrowserWorkspace, another tab still holding the record', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    resetBrowserWorkspaceIdForTests()
  })

  it('a save from a copy held before the move does not bring the record back', async () => {
    const { docs, sourceId } = await seedTwoWorkspaces()
    // Another tab's backend: the whole record in memory, under the id it read.
    const held = await docs.open(sourceId)
    if (held === null) throw new Error('the seed has no record')

    await demoteBrowserWorkspace(sourceId)
    held.getText('typed-after-the-move').insert(0, 'typed in the other tab')
    await expect(saveAndAnnounce(docs, sourceId, held)).rejects.toSatisfy(isWorkspaceRemovedError)

    expect(await docs.open(sourceId)).toBeNull()
  })

  it('a create under the old id does not register the workspace again', async () => {
    const { docs, sourceId } = await seedTwoWorkspaces()

    await demoteBrowserWorkspace(sourceId)
    await expect(
      new FoldingBrowserIndex().createWorkspace({ workspaceId: sourceId }),
    ).rejects.toSatisfy(isWorkspaceRemovedError)

    expect(await registryRows()).not.toContain(sourceId)
    expect(await docs.open(sourceId)).toBeNull()
  })
})

function pageHandlers(): DocumentBackendHandlers {
  return {
    onSnapshot: vi.fn(),
    onRemoteUpdate: vi.fn(),
    onVersionCreated: vi.fn(),
    onRestoreStarted: vi.fn(),
    onRestoreComplete: vi.fn(),
    onViewportRequest: vi.fn(),
    onConnected: vi.fn(),
    onError: vi.fn(),
  }
}

/** A page open on `documentId`, as a session holds it: the backend and its own copy. */
async function openPage(documentId: string, path: string) {
  const backend = new BrowserBackend({ documentId, path, kind: 'spatial' })
  const h = pageHandlers()
  backend.connect(h)
  await vi.waitFor(() => expect(h.onSnapshot).toHaveBeenCalledTimes(1), { timeout: 10_000 })
  const doc = new LoroDoc()
  doc.import(vi.mocked(h.onSnapshot).mock.calls[0][0])
  return { backend, h, doc }
}

/** Whether the page's copy still holds its document, once it has merged what it was handed. */
function pageStillHolds(page: Awaited<ReturnType<typeof openPage>>, documentId: string): boolean {
  for (const [bytes] of vi.mocked(page.h.onRemoteUpdate).mock.calls) page.doc.import(bytes)
  return resolveWorkspaceDocumentById(page.doc, documentId) !== null
}

describe('demoteBrowserWorkspace, a page open on the moved workspace', () => {
  const pages: BrowserBackend[] = []
  beforeEach(async () => {
    await clearWhiteboardDb()
    resetBrowserWorkspaceIdForTests()
  })
  afterEach(() => {
    for (const backend of pages.splice(0)) backend.disconnect()
    vi.unstubAllGlobals()
  })

  it('locks as the move lands, before anything is typed', async () => {
    const { sourceId, sketch } = await seedTwoWorkspaces()
    const page = await openPage(sketch.documentId, 'sketch')
    pages.push(page.backend)

    await demoteBrowserWorkspace(sourceId)

    await vi.waitFor(() => expect(pageStillHolds(page, sketch.documentId)).toBe(false), {
      timeout: 10_000,
    })
  })

  it('that missed the notice locks on its next edit instead of writing it', async () => {
    const { docs, sourceId, sketch } = await seedTwoWorkspaces()
    const page = await openPage(sketch.documentId, 'sketch')
    pages.push(page.backend)
    // No channel while the move runs: the notice never reaches the page.
    vi.stubGlobal('BroadcastChannel', undefined)
    await demoteBrowserWorkspace(sourceId)
    vi.unstubAllGlobals()

    const from = page.doc.version()
    writeSpatialNode(
      documentContainers(page.doc, sketch.documentId),
      textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text: 'typed after' }),
    )
    await page.backend.pushLocalUpdate(page.doc.export({ mode: 'update', from }))

    expect(pageStillHolds(page, sketch.documentId)).toBe(false)
    expect(page.h.onError).not.toHaveBeenCalled()
    expect(await docs.open(sourceId)).toBeNull()
    // Nor under the id this realm moved on to: a page writes only the record it loaded.
    const fresh = await docs.open(getBrowserWorkspaceId())
    const freshIds = fresh === null ? [] : readWorkspaceDocuments(fresh).map((d) => d.documentId)
    expect(freshIds).not.toContain(sketch.documentId)
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
    // Registered so the record may be minted at all; which keeper holds it
    // is not what this asks.
    await new FoldingBrowserIndex().createWorkspace({ workspaceId: 'ws-replica' })
    const record = await docs.create('ws-replica')
    // A record with no documents: ids are absent, so nothing is carried.
    writeDocumentKind(record, 'markdown')
    await docs.save('ws-replica', record)
    expect(readWorkspaceDocuments(record)).toEqual([])
    expect(await replicaCarriesAll(docs, 'ws-replica', ['01ARZ3NDEKTSV4RRFFQ69G5FAV'])).toBe(false)
    expect(await replicaCarriesAll(docs, 'ws-replica', [])).toBe(true)
  })
})
