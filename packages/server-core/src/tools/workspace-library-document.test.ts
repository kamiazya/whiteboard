// The one reader both workspace libraries (stencils, tags) go through: find
// the document at a well-known path, hand back its facets, or nothing.
import { writeDocumentKind, writeFacets } from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, test, vi } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { listWorkspaceDocuments, readWorkspaceLibraryFacets } from './workspace-library-document.js'

const WORKSPACE_ID = 'ws-1'
const LIBRARY_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
const OTHER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX'
const LIBRARY_PATH = 'some-library'
const FACET_KEY = 'example.library/v1'

async function deps(libraryAt: string | undefined) {
  const store = new FakeDocumentStore()
  await seedDoc(store, OTHER_ID, (doc) => writeDocumentKind(doc, 'markdown'))
  await registerDocumentInWorkspace(store, WORKSPACE_ID, OTHER_ID)
  if (libraryAt !== undefined) {
    await seedDoc(store, LIBRARY_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeFacets(doc, { [FACET_KEY]: { held: true } })
    })
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: LIBRARY_ID,
      path: libraryAt,
      kind: 'markdown',
    })
  }
  return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
}

describe('readWorkspaceLibraryFacets', () => {
  test('answers the facets of the document at the path', async () => {
    const facets = await readWorkspaceLibraryFacets(
      await deps(LIBRARY_PATH),
      WORKSPACE_ID,
      LIBRARY_PATH,
      'deployment',
    )
    expect(facets).toEqual({ [FACET_KEY]: { held: true } })
  })

  test('answers nothing when the workspace has no document at the path', async () => {
    expect(
      await readWorkspaceLibraryFacets(
        await deps(undefined),
        WORKSPACE_ID,
        LIBRARY_PATH,
        'deployment',
      ),
    ).toBeUndefined()
  })

  test('ignores a document at any other path', async () => {
    expect(
      await readWorkspaceLibraryFacets(
        await deps('elsewhere'),
        WORKSPACE_ID,
        LIBRARY_PATH,
        'deployment',
      ),
    ).toBeUndefined()
  })

  test('reads from a listing the caller already holds instead of listing again', async () => {
    const held = await deps(LIBRARY_PATH)
    const listing = await listWorkspaceDocuments(held, WORKSPACE_ID, 'deployment')
    const list = vi.spyOn(held.documentIndex, 'listDocuments')
    const facets = await readWorkspaceLibraryFacets(
      held,
      WORKSPACE_ID,
      LIBRARY_PATH,
      'deployment',
      listing,
    )
    expect(facets).toEqual({ [FACET_KEY]: { held: true } })
    expect(list).not.toHaveBeenCalled()
  })

  test('an unknown workspace degrades to nothing or refuses, as the caller says', async () => {
    const held = await deps(LIBRARY_PATH)
    expect(
      await readWorkspaceLibraryFacets(held, 'ws-nobody-made', LIBRARY_PATH, 'deployment'),
    ).toBeUndefined()
    await expect(
      readWorkspaceLibraryFacets(held, 'ws-nobody-made', LIBRARY_PATH, 'refuse'),
    ).rejects.toThrow()
  })
})
