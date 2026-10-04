// A workspace's stencil library is content a person (or a model) types, and
// the registry refuses a stencil whose facet payloads its plugin rejects.
// `wb_facet_set` is where that refusal has to happen, with the author
// present: a library stored unchecked is dropped unseen by every later read.
import { readFacets, writeDocumentKind } from '@kamiazya/whiteboard-loro-adapter'
import {
  readStencilLibrary,
  STENCIL_LIBRARY_PATH,
  VISUAL_STENCILS_KEY,
  VISUAL_TAGS_KEY,
} from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, test } from 'vitest'
import { loadOrCreateDocument } from '../document-io.js'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { FacetWriteRejectedError } from './errors.js'
import { createFacetSetTool } from './facet-set.js'

const LIBRARY_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
const WORKSPACE_ID = 'ws-1'

const libraryDocument = async () => {
  const store = new FakeDocumentStore()
  await seedDoc(store, LIBRARY_ID, (doc) => writeDocumentKind(doc, 'markdown'))
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: LIBRARY_ID,
    path: STENCIL_LIBRARY_PATH,
    kind: 'markdown',
  })
  return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
}

const writeLibrary = (deps: Awaited<ReturnType<typeof libraryDocument>>, stencils: unknown) =>
  createFacetSetTool(deps).execute({
    workspaceId: WORKSPACE_ID,
    documentIds: [LIBRARY_ID],
    facets: { [VISUAL_STENCILS_KEY]: { stencils } },
  } as never)

describe('wb_facet_set refuses a stencil library the registry would not accept', () => {
  test.each([
    {
      what: 'a facet payload its plugin rejects',
      stencils: {
        worse: { displayName: 'W', facets: { 'visual.shape/v0': { kind: 'blob' } } },
      },
      names: [/worse/, /visual\.shape\/v0/],
    },
    {
      what: 'a facet key no plugin registered',
      stencils: { u: { displayName: 'U', facets: { 'nope.nothing/v0': { a: 1 } } } },
      names: [/\bu\b/, /nope\.nothing\/v0/],
    },
    {
      what: 'a colour that is neither a preset nor a hex colour',
      stencils: { bad: { displayName: 'Bad', color: 'red' } },
      names: [/bad/, /color/, /"1" to "6"/],
    },
  ])('$what, naming the stencil and what is wrong', async ({ stencils, names }) => {
    const deps = await libraryDocument()
    const refusal = await writeLibrary(deps, stencils).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refusal).toBeInstanceOf(FacetWriteRejectedError)
    for (const name of names) expect((refusal as Error).message).toMatch(name)

    const stored = readFacets(await loadOrCreateDocument(deps, WORKSPACE_ID, LIBRARY_ID))
    expect(stored?.[VISUAL_STENCILS_KEY]).toBeUndefined()
  })

  test('one bad stencil refuses the whole write, and the good ones beside it are not stored', async () => {
    const deps = await libraryDocument()
    await expect(
      writeLibrary(deps, {
        good: { displayName: 'Good', color: '2' },
        worse: { displayName: 'W', facets: { 'visual.shape/v0': { kind: 'blob' } } },
      }),
    ).rejects.toThrow(/worse/)
    const stored = readFacets(await loadOrCreateDocument(deps, WORKSPACE_ID, LIBRARY_ID))
    expect(stored?.[VISUAL_STENCILS_KEY]).toBeUndefined()
  })

  test('accepts a library of presets, hex colours and valid facet payloads', async () => {
    const deps = await libraryDocument()
    await writeLibrary(deps, {
      bucket: {
        displayName: 'Bucket',
        color: '#ff0000',
        facets: { 'visual.shape/v0': { kind: 'cylinder' } },
      },
      plain: { displayName: 'Plain', color: '3' },
    })
    const stored = readFacets(await loadOrCreateDocument(deps, WORKSPACE_ID, LIBRARY_ID))
    expect(Object.keys(readStencilLibrary(stored))).toEqual(['bucket', 'plain'])
  })

  test('does not look at a write that carries no library', async () => {
    const deps = await libraryDocument()
    await expect(
      createFacetSetTool(deps).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [LIBRARY_ID],
        facets: { [VISUAL_TAGS_KEY]: { keys: {} } },
      } as never),
    ).resolves.toBeDefined()
  })
})
