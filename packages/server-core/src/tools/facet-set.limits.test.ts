// The ceiling `wb_facet_set` puts on one request. The number is part of the
// published input schema, so it is pinned as a literal rather than imported.

import {
  readCoreFacets,
  writeCoreFacets,
  writeDocumentKind,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  TAG_COUNT_LIMIT_PHRASE,
  TAG_MAX_CHARS,
  TAGS_PER_ELEMENT_MAX,
} from '@kamiazya/whiteboard-model'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createFacetSetTool, facetSetInputSchema } from './facet-set.js'

const WORKSPACE_ID = 'ws-1'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

describe('wb_facet_set — documents per request', () => {
  const request = (count: number) => ({
    workspaceId: 'ws-1',
    tags: { add: ['x'] },
    documentIds: Array.from(
      { length: count },
      (_, i) => `01H8XJZ9K5N4M3P2Q1R0S9T8${String(i).padStart(2, '0')}`,
    ),
  })

  test('accepts 50 documents', () => {
    expect(facetSetInputSchema.safeParse(request(50)).success).toBe(true)
  })

  test('refuses 51 documents', () => {
    expect(facetSetInputSchema.safeParse(request(51)).success).toBe(false)
  })
})

describe('wb_facet_set — what a tag change costs', () => {
  test('applies a change to a document holding many stored tags in time linear in them', async () => {
    // Tags stored before any bound held are still taken by a change that
    // does not grow them, so the change's own cost has to stay linear in
    // what is stored rather than in what the request carries.
    const stored = 60_000
    const tags = Array.from({ length: stored }, (_, i) => `t${i}`)
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeCoreFacets(doc, { type: 'note', tags })
    })
    const tool = createFacetSetTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    const started = performance.now()
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      tags: { remove: ['t0'] },
    })
    const elapsed = performance.now() - started

    expect(result.updated[0]?.tags).toHaveLength(stored - 1)
    expect(elapsed / stored).toBeLessThan(0.08)
  })
})

describe('wb_facet_set — tags per element', () => {
  const request = (add: string[]) => ({
    workspaceId: WORKSPACE_ID,
    documentIds: [DOCUMENT_ID],
    tags: { add },
  })
  const tagsOf = (count: number) => Array.from({ length: count }, (_, i) => `t${i}`)

  async function noteTagged(tags: string[]): Promise<FakeDocumentStore> {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeCoreFacets(doc, { type: 'note', tags })
    })
    return store
  }

  async function storedTags(store: FakeDocumentStore): Promise<string[] | undefined> {
    const loaded = await store.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    })
    if (loaded === null) throw new Error('nothing stored')
    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
    return readCoreFacets(doc)?.tags
  }

  test('refuses an add carrying more tags than one element may, or a tag longer than one may be', () => {
    expect(facetSetInputSchema.safeParse(request(tagsOf(TAGS_PER_ELEMENT_MAX))).success).toBe(true)
    expect(facetSetInputSchema.safeParse(request(tagsOf(TAGS_PER_ELEMENT_MAX + 1))).success).toBe(
      false,
    )
    expect(facetSetInputSchema.safeParse(request(['a'.repeat(TAG_MAX_CHARS + 1)])).success).toBe(
      false,
    )
  })

  test('refuses a change that grows a set past the bound, and writes nothing', async () => {
    const store = await noteTagged(tagsOf(TAGS_PER_ELEMENT_MAX))
    const tool = createFacetSetTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    const refused = tool.execute(request(['one-more']))
    await expect(refused).rejects.toMatchObject({ name: 'TooManyTagsError' })
    await expect(refused).rejects.toThrow(TAG_COUNT_LIMIT_PHRASE)
    expect(await storedTags(store)).toHaveLength(TAGS_PER_ELEMENT_MAX)
  })

  test('takes a change that leaves a set stored past the bound no larger', async () => {
    const stored = tagsOf(TAGS_PER_ELEMENT_MAX + 10)
    const store = await noteTagged(stored)
    const tool = createFacetSetTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    const result = await tool.execute({
      ...request([]),
      tags: { add: ['t0', 'fresh'], remove: ['t1'] },
    })
    expect(result.updated[0]?.tags).toHaveLength(stored.length)
  })
})
