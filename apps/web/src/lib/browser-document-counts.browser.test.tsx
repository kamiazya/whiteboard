/**
 * Counting the browser keeper's workspaces, against real IndexedDB and the
 * real Loro wasm — which is the whole subject: this module exists precisely
 * because the count cannot be had without them.
 */
import { adoptWorkspaceDocument } from '@kamiazya/whiteboard-loro-adapter'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { browserDocumentCounts } from './browser-document-counts.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import {
  resetBrowserWorkspaceIdForTests,
  setBrowserWorkspaceIdForTests,
} from './browser-workspace-id.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { LoroStore } from './loro-store.js'

const DB_NAME = claimIsolatedWhiteboardDb('browser-doc-counts')
const ACTIVE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SECOND = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

beforeEach(async () => {
  await deleteDb()
  // Through the seam rather than whatever the page resolved earlier. The
  // accessor is a module singleton shared by every test in this browser page,
  // and `deleteDb` above pulls the row it resolved from under it — so leaving
  // it ambient made this file assert against an id it did not choose, and a
  // re-resolution added a third workspace nothing had seeded.
  setBrowserWorkspaceIdForTests(ACTIVE)
})

afterEach(resetBrowserWorkspaceIdForTests)

function spatialDoc(text: string): Loro {
  const doc = new Loro()
  doc.getMap('nodes').set('n1', { id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text })
  doc.commit()
  return doc
}

/**
 * An OLDER build's documents: rows in the legacy per-document plane, which
 * only the startup fold moves into the tree. Only the original browser
 * workspace can have these — multi-workspace arrived after the tree did.
 */
async function seedLegacy(workspaceId: string, paths: readonly string[]): Promise<void> {
  const index = new IdbDocumentIndex(DB_NAME)
  await index.createWorkspace({ workspaceId })
  for (const path of paths) {
    const entry = await index.createDocument({ workspaceId, path, kind: 'spatial' })
    await new LoroStore(DB_NAME).save(
      entry.documentId,
      spatialDoc(path).export({ mode: 'snapshot' }),
    )
  }
}

/** What every workspace created today holds: documents already in the tree. */
async function seedTree(workspaceId: string, paths: readonly string[]): Promise<void> {
  await new IdbDocumentIndex(DB_NAME).createWorkspace({ workspaceId })
  const docs = new BrowserWorkspaceDocs(DB_NAME)
  const workspace = await docs.create(workspaceId)
  for (const [i, path] of paths.entries()) {
    adoptWorkspaceDocument(
      workspace,
      { path, documentId: `01ARZ3NDEKTSV4RRFFQ69G5F0${i}`, kind: 'spatial' },
      spatialDoc(path),
    )
  }
  await docs.save(workspaceId, workspace)
}

it('counts each workspace separately', async () => {
  // One workspace per plane, because both are real and only one of them
  // is reached by the fold.
  await seedLegacy(ACTIVE, ['design', 'archive/notes'])
  await seedTree(SECOND, ['only-one'])

  const counts = await browserDocumentCounts(DB_NAME)

  // Both seeded workspaces PRESENT, not merely "what is present is right" —
  // a count map that silently lost one answers `undefined`, which the row
  // renders as no number at all. That reads exactly like a keeper that does
  // not count, so the absence has to fail here or nowhere.
  //
  // Asserted as a SUBSET rather than the whole key set: opening a fresh
  // database runs its upgrade chain, which seeds a `'local'` row and then
  // rekeys it to a freshly minted canonical ULID. That third workspace is
  // the database's, not this test's, and pinning an exact set would make
  // this fail whenever the migrations change something it never meant to
  // assert about.
  expect(counts.has(ACTIVE)).toBe(true)
  expect(counts.has(SECOND)).toBe(true)
  expect(counts.get(ACTIVE)).toBe(2)
  expect(counts.get(SECOND)).toBe(1)
})

it('answers 0 for a workspace that exists and holds nothing', async () => {
  // Zero is the row a person most needs to recognise, and it is a different
  // answer from absent — which is why this module returns a number rather
  // than omitting the key.
  await new IdbDocumentIndex(DB_NAME).createWorkspace({ workspaceId: ACTIVE })

  const counts = await browserDocumentCounts(DB_NAME)

  expect(counts.get(ACTIVE)).toBe(0)
})
