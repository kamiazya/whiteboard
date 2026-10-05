// The ceiling `wb_facet_set` puts on one request. The number is part of the
// published input schema, so it is pinned as a literal rather than imported.

import { writeCoreFacets, writeDocumentKind } from '@kamiazya/whiteboard-loro-adapter'
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
