/**
 * The summary layer: what `DocumentIndex` does not own.
 *
 * The port answers placement, identity, kind and name. Two things a
 * browser user still needs are not in it and are not gaps in it — the
 * pointer to the document a plain load resumes into, and when a document was
 * last edited. Both are apps/web product concerns, so they live here rather
 * than bending the contract around them.
 */

import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import {
  IdbDefaultDocumentPointer,
  idbContentClock,
  listBrowserDocuments,
} from './browser-document-summary.js'
import { getBrowserWorkspaceId, setBrowserWorkspaceIdForTests } from './browser-workspace-id.js'
import { LoroStore } from './loro-store.js'

const DB_NAME = 'whiteboard-summary-test'

/**
 * The index answers placement only; what this layer adds is read from the
 * content stores under `DB_NAME`, so an in-memory index keeps the subject
 * to that layer alone.
 */
async function seedWorkspace(): Promise<InMemoryDocumentIndex> {
  // This file's DB is claimed by literal name rather than through
  // `claimIsolatedWhiteboardDb` (it predates that helper), so the
  // `getBrowserWorkspaceId()` seam is not set for it automatically — set it
  // fresh per test instead, matching what the seam-owning helper does.
  setBrowserWorkspaceIdForTests(generateDocumentId())
  const index = new InMemoryDocumentIndex()
  await index.createWorkspace({ workspaceId: getBrowserWorkspaceId() })
  return index
}

async function writeContent(documentId: string): Promise<void> {
  const doc = new Loro()
  doc.getList('elements').push({ id: 'el' })
  await new LoroStore(DB_NAME).save(documentId, doc.export({ mode: 'snapshot' }))
}

describe('browser document summary', () => {
  beforeEach(() => clearNamedDb(DB_NAME))
  afterEach(() => clearNamedDb(DB_NAME))

  it('carries the index entry plus the time its content was last written', async () => {
    const index = await seedWorkspace()
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes',
      kind: 'markdown',
      name: 'Notes',
    })
    await writeContent(entry.documentId)

    const [row] = await listBrowserDocuments(index, idbContentClock(DB_NAME))
    expect(row?.documentId).toBe(entry.documentId)
    expect(row?.path).toBe('notes')
    expect(row?.name).toBe('Notes')
    expect(row?.kind).toBe('markdown')
    // A real ISO stamp from the content write, not a placeholder.
    expect(Date.parse(row?.updatedAt ?? '')).toBeGreaterThan(0)
  })

  it('says a document with no name of its own is unnamed, as the daemon does', async () => {
    // Null, not the path: a listing that substituted the path could not tell
    // a name somebody typed equal to it from no name at all. A surface that
    // needs a label derives one through `documentLabel`.
    const index = await seedWorkspace()
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'archive/untitled',
      kind: 'spatial',
    })
    await writeContent(entry.documentId)

    const [row] = await listBrowserDocuments(index, idbContentClock(DB_NAME))
    expect(row?.name).toBeNull()
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

    const rows = await listBrowserDocuments(index, idbContentClock(DB_NAME))
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
