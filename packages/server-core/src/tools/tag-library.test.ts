// A workspace's TAG library (ADR-0040 decision 5's declared layer): found
// at the well-known path `tags`, read off the document's facet, and the
// rules it declares applied to a tag set about to be written.
import { writeDocumentKind, writeFacets } from '@kamiazya/whiteboard-loro-adapter'
import { VISUAL_TAGS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import {
  refuseAgainstLibrary,
  TAG_LIBRARY_PATH,
  TagLibraryError,
  workspaceTagLibrary,
} from './tag-library.js'

const WORKSPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const LIBRARY_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
const OTHER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX'

const health = {
  health: { exclusive: true, values: { ok: { color: '4' }, failing: { color: '1' } } },
  owner: { description: 'The team on call' },
}

async function withLibrary(keys: Record<string, unknown> | undefined) {
  const store = new FakeDocumentStore()
  await seedDoc(store, OTHER_ID, (doc) => writeDocumentKind(doc, 'markdown'))
  await registerDocumentInWorkspace(store, WORKSPACE_ID, OTHER_ID)
  if (keys !== undefined) {
    await seedDoc(store, LIBRARY_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeFacets(doc, { [VISUAL_TAGS_KEY]: { keys } } as never)
    })
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: LIBRARY_ID,
      path: TAG_LIBRARY_PATH,
      kind: 'markdown',
    })
  }
  return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
}

describe('workspaceTagLibrary', () => {
  test('reads the library the document at `tags` declares, keys by name', async () => {
    const library = await workspaceTagLibrary(await withLibrary(health), WORKSPACE_ID, 'deployment')
    expect(Object.keys(library)).toEqual(['health', 'owner'])
    expect(library.health?.values?.ok?.color).toBe('4')
  })

  test('answers no keys for a workspace without one, and for a malformed one', async () => {
    expect(
      await workspaceTagLibrary(await withLibrary(undefined), WORKSPACE_ID, 'deployment'),
    ).toEqual({})
    expect(
      await workspaceTagLibrary(await withLibrary({ Health: {} }), WORKSPACE_ID, 'deployment'),
    ).toEqual({})
  })

  test('an unknown workspace degrades or refuses as the caller says, like the stencil library', async () => {
    const deps = await withLibrary(undefined)
    expect(await workspaceTagLibrary(deps, 'ws-nobody-made', 'deployment')).toEqual({})
    await expect(workspaceTagLibrary(deps, 'ws-nobody-made', 'refuse')).rejects.toThrow()
  })
})

describe('refuseAgainstLibrary', () => {
  const library = {
    health: { exclusive: true, values: { ok: {}, failing: {} } },
    owner: {},
    region: { values: { eu: {}, us: {} } },
  }

  test('lets through a plain tag, an undeclared key, and an admitted value', () => {
    expect(() =>
      refuseAgainstLibrary(library, ['draft', 'tier:web', 'health:ok', 'owner:core'], 'the board'),
    ).not.toThrow()
  })

  test('refuses a value the key does not admit, naming the key, the values, and what was written', () => {
    expect(() => refuseAgainstLibrary(library, ['health:degraded'], 'node redis')).toThrow(
      TagLibraryError,
    )
    expect(() => refuseAgainstLibrary(library, ['health:degraded'], 'node redis')).toThrow(
      /health:degraded.*node redis.*health.*failing, ok/,
    )
  })

  test('refuses two values under an exclusive key, and allows two under a key that is not', () => {
    expect(() =>
      refuseAgainstLibrary(library, ['health:ok', 'health:failing'], 'the board'),
    ).toThrow(/health.*one value.*health:ok.*health:failing/)
    expect(() =>
      refuseAgainstLibrary(library, ['region:eu', 'region:us'], 'the board'),
    ).not.toThrow()
  })

  test('with no library, everything passes', () => {
    expect(() => refuseAgainstLibrary({}, ['health:whatever', 'x:y'], 'the board')).not.toThrow()
  })
})
