// A stencil library is written through every whole-document writer as well as
// `wb_facet_set`: the same payload arrives as frontmatter YAML, and a library
// the registry will not compose is dropped unseen by every later read, so each
// writer refuses it with its author present.
import { readFacets } from '@kamiazya/whiteboard-loro-adapter'
import { VISUAL_STENCILS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, test } from 'vitest'
import { loadOrCreateDocument } from '../document-io.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSetTool } from './document-set.js'
import { FacetWriteRejectedError } from './errors.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

const unusableLibrary = [
  '---',
  'type: note',
  'facets:',
  `  ${VISUAL_STENCILS_KEY}:`,
  '    stencils:',
  '      worse:',
  '        displayName: W',
  '        facets:',
  '          visual.shape/v0:',
  '            kind: blob',
  '---',
  'body',
].join('\n')

const usableLibrary = unusableLibrary.replace('kind: blob', 'kind: cylinder')

const settle = (attempt: Promise<unknown>) =>
  attempt.then(
    () => undefined,
    (error: unknown) => error,
  )

describe('whole-document writers refuse a stencil library the registry would not accept', () => {
  test('wb_document_set refuses it, naming the stencil and facet, and writes nothing', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    const deps = makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })

    const refusal = await settle(
      createDocumentSetTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        markdown: unusableLibrary,
      }),
    )

    expect(refusal).toBeInstanceOf(FacetWriteRejectedError)
    expect((refusal as Error).message).toMatch(/worse/)
    expect((refusal as Error).message).toMatch(/visual\.shape\/v0/)
    const stored = readFacets(await loadOrCreateDocument(deps, WORKSPACE_ID, DOCUMENT_ID))
    expect(stored?.[VISUAL_STENCILS_KEY]).toBeUndefined()
  })

  test('wb_document_create refuses it before minting the document', async () => {
    const deps = makeTestDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: WORKSPACE_ID })

    const refusal = await settle(
      wbDocumentCreate(deps, {
        workspaceId: WORKSPACE_ID,
        path: 'library',
        kind: 'markdown',
        markdown: unusableLibrary,
      }),
    )

    expect(refusal).toBeInstanceOf(FacetWriteRejectedError)
    expect(await deps.documentIndex.listDocuments({ workspaceId: WORKSPACE_ID })).toEqual([])
  })

  test('a library of valid stencils is stored', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    const deps = makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })

    await createDocumentSetTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      markdown: usableLibrary,
    })

    const stored = readFacets(await loadOrCreateDocument(deps, WORKSPACE_ID, DOCUMENT_ID))
    expect(
      Object.keys(stored?.[VISUAL_STENCILS_KEY] as { stencils: object }).length,
    ).toBeGreaterThan(0)
  })
})
