/**
 * Counting the browser keeper's workspaces, against real IndexedDB and the
 * real Loro wasm — which is the whole subject: this module exists precisely
 * because the count cannot be had without them.
 */

import {
  createWorkspaceDocumentAtPath,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { expectLoggedFailures } from '../test-utils/browser-setup.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedLegacyRow } from '../test-utils/seed-legacy-row.js'
import { browserDocumentCounts } from './browser-document-counts.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import {
  resetBrowserWorkspaceIdForTests,
  setBrowserWorkspaceIdForTests,
} from './browser-workspace-id.js'
import { IdbDocumentIndex } from './idb-document-index.js'

const DB_NAME = claimIsolatedWhiteboardDb('browser-doc-counts')
const ACTIVE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SECOND = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

beforeEach(async () => {
  await clearWhiteboardDb()
  // Through the seam rather than whatever the page resolved earlier. The
  // accessor is a module singleton shared by every test in this browser page,
  // and `clearWhiteboardDb` above pulls the row it resolved from under it — so leaving
  // it ambient made this file assert against an id it did not choose, and a
  // re-resolution added a third workspace nothing had seeded.
  setBrowserWorkspaceIdForTests(ACTIVE)
})

afterEach(resetBrowserWorkspaceIdForTests)

function spatialDoc(text: string): Loro {
  const doc = new Loro()
  doc.getMap('nodes').set('n1', textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text }))
  doc.commit()
  return doc
}

/** What every workspace created today holds: documents already in the tree. */
async function seedTree(workspaceId: string, paths: readonly string[]): Promise<void> {
  await new IdbDocumentIndex(DB_NAME).createWorkspace({ workspaceId })
  const docs = new BrowserWorkspaceDocs(DB_NAME)
  const workspace = await docs.create(workspaceId)
  for (const path of paths) {
    const documentId = generateDocumentId()
    createWorkspaceDocumentAtPath(workspace, { path, documentId, kind: 'spatial' })
    writeWorkspaceDocumentContent(workspace, documentId, spatialDoc(path))
  }
  await docs.save(workspaceId, workspace)
}

it('counts each workspace separately', async () => {
  await seedTree(ACTIVE, ['design', 'archive/notes'])
  await seedTree(SECOND, ['only-one-other'])

  const counts = await browserDocumentCounts(DB_NAME)

  // Both seeded workspaces PRESENT, not merely "what is present is right" —
  // a count map that silently lost one answers `undefined`, which the row
  // renders as no number at all. That reads exactly like a keeper that does
  // not count, so the absence has to fail here or nowhere.
  //
  // Asserted as a SUBSET rather than the whole key set: opening a fresh
  // database creates its baseline, which mints a workspace row of its own
  // under a fresh canonical ULID. That third workspace is the database's,
  // not this test's, and pinning an exact set would make this fail whenever
  // the baseline changes something it never meant to assert about.
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

it('leaves a refused workspace uncounted rather than counting it as empty', async () => {
  const logged = expectLoggedFailures()
  await seedTree(SECOND, ['kept'])
  await new IdbDocumentIndex(DB_NAME).createWorkspace({ workspaceId: ACTIVE })
  await seedLegacyRow({ workspaceId: ACTIVE, path: 'old', kind: 'spatial' }, DB_NAME)

  const counts = await browserDocumentCounts(DB_NAME)

  expect(counts.has(ACTIVE)).toBe(false)
  expect(counts.get(SECOND)).toBe(1)
  expect(logged.join('\n')).toContain('could not count a workspace')
})
