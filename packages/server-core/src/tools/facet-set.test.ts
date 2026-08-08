import { reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { readFacets } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeCanvasDocStore,
  registerCanvasInWorkspace,
} from '../test-utils/fake-canvas-doc-store.js'
import { createInMemoryWorkspaceIndex } from '../test-utils/in-memory-workspace-index.js'
import { CanvasNotFoundError } from './canvas-crud.errors.js'
import { wbCanvasCreate } from './canvas-crud.js'
import { createFacetSetTool, facetSetInputSchema } from './facet-set.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, workspaceIndex: createInMemoryWorkspaceIndex(), blobStore: {} as never }
}

describe('facet_set tool', () => {
  test('sets a facet on a canvas with no prior snapshot', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(canvasDocStore, WORKSPACE_ID, CANVAS_ID)
    const tool = createFacetSetTool(makeDeps(canvasDocStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      facets: { 'kanban/1': { status: 'todo' } },
    })

    expect(result).toEqual({
      canvasId: CANVAS_ID,
      facets: { 'kanban/1': { status: 'todo' } },
    })
  })

  test('persists the facet so a later load reflects it', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const tool = createFacetSetTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      facets: { 'kanban/1': { status: 'todo' } },
    })

    const loaded = await store.loadSnapshot({
      docRef: { kind: 'canvas', canvasId: CANVAS_ID },
    })
    expect(loaded).not.toBeNull()
    const doc = new LoroDoc()
    if (loaded !== null) {
      doc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
    }
    expect(readFacets(doc)).toEqual({ 'kanban/1': { status: 'todo' } })
  })

  test('merges a new facet domain with an existing one instead of replacing it', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(canvasDocStore, WORKSPACE_ID, CANVAS_ID)
    const tool = createFacetSetTool(makeDeps(canvasDocStore))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      facets: { 'kanban/1': { status: 'todo' } },
    })
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      facets: { 'priority/1': { level: 'high' } },
    })

    expect(result.facets).toEqual({
      'kanban/1': { status: 'todo' },
      'priority/1': { level: 'high' },
    })
  })

  test('overwrites an existing facet domain when the same key is set again', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(canvasDocStore, WORKSPACE_ID, CANVAS_ID)
    const tool = createFacetSetTool(makeDeps(canvasDocStore))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      facets: { 'kanban/1': { status: 'todo' } },
    })
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      facets: { 'kanban/1': { status: 'done' } },
    })

    expect(result.facets).toEqual({ 'kanban/1': { status: 'done' } })
  })

  test('throws CanvasNotFoundError when workspaceId does not actually own canvasId', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(canvasDocStore, WORKSPACE_ID, CANVAS_ID)
    const tool = createFacetSetTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({
        workspaceId: 'ws-other',
        canvasId: CANVAS_ID,
        facets: { 'kanban/1': { status: 'todo' } },
      }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  test('rejects a facet key outside the {domain}/{version} pattern', () => {
    expect(() =>
      facetSetInputSchema.parse({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        facets: { title: 'not an extension facet' },
      }),
    ).toThrow()
  })

  test('reindexes the workspace so queryFacet reflects the newly-set facet', async () => {
    const deps = makeDeps(new FakeCanvasDocStore())
    const created = await wbCanvasCreate(deps, {
      workspaceId: WORKSPACE_ID,
      segment: 'doc-a',
      createWorkspace: true,
    })
    const tool = createFacetSetTool(deps)

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: created.canvasId,
      facets: { 'kanban/1': { status: 'todo' } },
    })

    const hit = await deps.workspaceIndex.queryFacet({
      workspaceId: WORKSPACE_ID,
      facet: 'facets.kanban/1',
      value: '',
    })
    expect(hit.canvasIds).toEqual([created.canvasId])
  })
})
