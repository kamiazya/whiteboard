// A workspace's TAG library (ADR-0040 decision 5's declared layer): found
// at the well-known path `tags`, read off the document's facet, and the
// rules it declares applied to a tag set about to be written.
import { writeDocumentKind, writeFacets } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { VISUAL_TAGS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import {
  carriesATag,
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

const tagGeo = { x: 0, y: 0, width: 10, height: 10 }
const plain = (id: string) => textNode({ id, ...tagGeo, text: id })
const tagged = (id: string) => textNode({ id, ...tagGeo, text: id, tags: ['k:v'] })
const edge = (id: string, tags?: string[]) => ({
  id,
  from: { node: 'a' },
  to: { node: 'b' },
  ...(tags === undefined ? {} : { tags }),
})

describe('carriesATag decides whether a render loads the tag library at all', () => {
  test('is false for an untagged board, including empty tag lists', () => {
    const board: SpatialCanvas = {
      tags: [],
      nodes: [plain('a'), { ...plain('b'), tags: [] }],
      edges: [edge('e', [])],
    }
    expect(carriesATag(board)).toBe(false)
    expect(carriesATag({ nodes: [], edges: [] })).toBe(false)
  })

  test.each<[string, SpatialCanvas]>([
    ['the board', { tags: ['k:v'], nodes: [plain('a')], edges: [] }],
    ['the last node', { nodes: [plain('a'), plain('c'), tagged('b')], edges: [] }],
    ['the first node', { nodes: [tagged('a'), plain('b'), plain('c')], edges: [] }],
    [
      'the last edge',
      { nodes: [plain('a'), plain('b')], edges: [edge('e1'), edge('e2'), edge('e3', ['k:v'])] },
    ],
    [
      'the first edge',
      { nodes: [plain('a'), plain('b')], edges: [edge('e1', ['k:v']), edge('e2'), edge('e3')] },
    ],
  ])('is true when only %s carries a tag', (_name, board) => {
    expect(carriesATag(board)).toBe(true)
  })
})
