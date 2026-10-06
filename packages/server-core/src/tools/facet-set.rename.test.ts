// How `wb_facet_set` applies a rename: where it reaches, how it composes
// with a removal in the same write, and which of two renames of one tag
// wins. The common rename cases live in facet-set.test.ts.

import {
  writeDocumentKind,
  writeFacets,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { type SpatialCanvas, TAGS_PER_ELEMENT_MAX } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createFacetSetTool, type FacetSetInput } from './facet-set.js'
import { TAG_LIBRARY_PATH } from './tag-library.js'

const WORKSPACE_ID = 'ws-1'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const LIBRARY_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8W0'

const box = (id: string, tags?: string[]) =>
  textNode({ id, x: 0, y: 0, width: 100, height: 50, text: id, ...(tags && { tags }) })

async function board(canvas: SpatialCanvas, library?: Record<string, unknown>) {
  const store = new FakeDocumentStore()
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, canvas)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  if (library !== undefined) {
    await seedDoc(store, LIBRARY_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeFacets(doc, { 'visual.tags/v0': { keys: library } } as never)
    })
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: LIBRARY_ID,
      path: TAG_LIBRARY_PATH,
      kind: 'markdown',
    })
  }
  return createFacetSetTool(
    makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
  )
}

const renameOnNode = (tags: NonNullable<FacetSetInput['tags']>) => ({
  workspaceId: WORKSPACE_ID,
  documentIds: [DOCUMENT_ID],
  nodeId: 'n1',
  tags,
})

describe('wb_facet_set rename', () => {
  // The node twin is in facet-set.test.ts; a board-wide rename's dry run
  // walks the edges separately, and a library refusal must reach them too.
  test('a rename through the board is checked on every edge it reaches', async () => {
    const tool = await board(
      {
        nodes: [box('api'), box('db')],
        edges: [{ id: 'link', from: { node: 'api' }, to: { node: 'db' }, tags: ['health:ok'] }],
      },
      { health: { exclusive: true, values: { ok: {}, failing: {} } } },
    )
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        tags: { rename: [{ from: 'health:ok', to: 'health:degraded' }] },
      }),
    ).rejects.toThrow(/health:degraded.*edge link/)
  })

  test('a removal in the same write names the renamed spelling, not the old one', async () => {
    const tool = await board({ nodes: [box('n1', ['a', 'x', 'y'])], edges: [] })
    const result = await tool.execute(
      renameOnNode({
        rename: [
          { from: 'a', to: 'b' },
          { from: 'x', to: 'z' },
        ],
        remove: ['b', 'x'],
      }),
    )
    // `b` is dropped as renamed; `x` was renamed away before the removal looked.
    expect(result.updated[0]?.tags).toEqual(['z', 'y'])
  })

  test('two renames of one tag take the first', async () => {
    const tool = await board({ nodes: [box('n1', ['a'])], edges: [] })
    const result = await tool.execute(
      renameOnNode({
        rename: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'c' },
        ],
      }),
    )
    expect(result.updated[0]?.tags).toEqual(['b'])
  })
})

describe('wb_facet_set rename — what a long rename list costs', () => {
  const originalSet = Map.prototype.set
  afterEach(() => {
    Map.prototype.set = originalSet
  })

  // A rename list is compiled into its lookup ONCE per call, not once per
  // element it is applied to: rebuilt per element, a board-wide rename costs
  // elements x renames, which was 32 s for 2,000 nodes and 100,000 renames.
  // Counted rather than timed, so the guard does not depend on the machine.
  test('builds the rename lookup once, however many elements the board holds', async () => {
    const nodes = 500
    const tool = await board({
      nodes: Array.from({ length: nodes }, (_, i) => box(`n${i}`, ['keep'])),
      edges: [],
    })
    const rename = Array.from({ length: TAGS_PER_ELEMENT_MAX }, (_, i) => ({
      from: `old${i}`,
      to: 'new',
    }))
    let sets = 0
    Map.prototype.set = function counted(this: Map<unknown, unknown>, key, value) {
      sets += 1
      return originalSet.call(this, key, value)
    }

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      tags: { rename },
    })
    Map.prototype.set = originalSet

    expect(result.updated).toHaveLength(1)
    // One lookup holds `rename.length` entries; a rebuild per element would
    // be `nodes` times that, twice over (the dry run and the write).
    expect(sets).toBeLessThan(rename.length * 4)
  })
})
