/**
 * The summary layer: what `DocumentIndex` does not own.
 *
 * The port answers placement, identity, kind and name. Two things a
 * browser user still needs are not in it and are not gaps in it — the
 * pointer to the document a plain load resumes into, and when a document was
 * last edited. Both are apps/web product concerns, so they live here rather
 * than bending the contract around them.
 */

// jsdom + fake-indexeddb: this file exercises IndexedDB persistence logic,
// not browser layout or input fidelity — the real-IDB contract stays pinned
// by idb-document-index/loro-store/browser-backend/browser-idb-migration
// in the browser project.
import 'fake-indexeddb/auto'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import {
  IdbDefaultDocumentPointer,
  idbContentClock,
  listLocalDocuments,
} from './local-document-summary.js'
import { LoroStore } from './loro-store.js'

const DB_NAME = 'whiteboard-summary-test'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

async function seedWorkspace(): Promise<IdbDocumentIndex> {
  const index = new IdbDocumentIndex(DB_NAME)
  await index.createWorkspace({ workspaceId: getBrowserWorkspaceId() })
  return index
}

async function writeContent(documentId: string): Promise<void> {
  const doc = new Loro()
  doc.getList('elements').push({ id: 'el' })
  await new LoroStore(DB_NAME).save(documentId, doc.export({ mode: 'snapshot' }))
}

describe('local document summary', () => {
  beforeEach(clearDb)
  afterEach(clearDb)

  it('carries the index entry plus the time its content was last written', async () => {
    const index = await seedWorkspace()
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes',
      kind: 'markdown',
      name: 'Notes',
    })
    await writeContent(entry.documentId)

    const [row] = await listLocalDocuments(index, idbContentClock(DB_NAME))
    expect(row?.documentId).toBe(entry.documentId)
    expect(row?.path).toBe('notes')
    expect(row?.name).toBe('Notes')
    expect(row?.kind).toBe('markdown')
    // A real ISO stamp from the content write, not a placeholder.
    expect(Date.parse(row?.updatedAt ?? '')).toBeGreaterThan(0)
  })

  it('falls back to the path when a document has no name of its own', async () => {
    // `DocumentEntry.name` is ABSENT rather than defaulted, on purpose: a
    // listing that invents one reads as though somebody typed the path in as
    // a title. Choosing the fallback is this layer's job, not the port's.
    const index = await seedWorkspace()
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'archive/untitled',
      kind: 'spatial',
    })
    await writeContent(entry.documentId)

    const [row] = await listLocalDocuments(index, idbContentClock(DB_NAME))
    expect(row?.name).toBe('archive/untitled')
  })

  it('lists a document whose content was never written, rather than hiding it', async () => {
    // Every create path seeds an empty content record, so this should not
    // happen — but a listing that drops a row it cannot timestamp would hide
    // stored data, which is the dishonest surface. It reports the epoch so
    // the sort puts it last rather than first.
    const index = await seedWorkspace()
    await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'contentless',
      kind: 'spatial',
    })

    const rows = await listLocalDocuments(index, idbContentClock(DB_NAME))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.updatedAt).toBe(new Date(0).toISOString())
  })

  it('remembers, and forgets, which document a plain load resumes into', async () => {
    const pointer = new IdbDefaultDocumentPointer(DB_NAME)
    expect(await pointer.get()).toBeNull()

    await pointer.set('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(await pointer.get()).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')

    await pointer.clear()
    expect(await pointer.get()).toBeNull()
  })
})
