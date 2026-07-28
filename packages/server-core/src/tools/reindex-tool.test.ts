import { WorkspaceTree } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { createInMemoryCanvasDocStore } from '../test-utils/in-memory-canvas-doc-store.js'
import { FakeWorkspaceIndex } from '../test-utils/fake-workspace-index.js'
import { createFacetSetTool } from './facet-set.js'
import { createReindexTool } from './reindex-tool.js'
import { saveWorkspaceTree } from './workspace-tree-io.js'

const WORKSPACE_ID = 'ws-1'
const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

describe('reindex tool', () => {
  test('returns canvasCount 0 for a workspace with no indexed canvases', async () => {
    const canvasDocStore = createInMemoryCanvasDocStore()
    const deps = {
      canvasDocStore,
      workspaceIndex: new FakeWorkspaceIndex(),
      blobStore: {} as never,
    }
    const tool = createReindexTool(deps)

    const result = await tool.execute({ workspaceId: WORKSPACE_ID })

    expect(result).toEqual({ reindexed: true, canvasCount: 0 })
  })

  test('reports the number of canvases with a saved snapshot after a manual reindex', async () => {
    const canvasDocStore = createInMemoryCanvasDocStore()
    const workspaceIndex = new FakeWorkspaceIndex()
    const deps = { canvasDocStore, workspaceIndex, blobStore: {} as never }

    const tree = new WorkspaceTree(new LoroDoc())
    tree.createNode(CANVAS_ID, 'my-canvas')
    await saveWorkspaceTree(canvasDocStore, WORKSPACE_ID, tree)

    const facetSet = createFacetSetTool(deps)
    await facetSet.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      facets: { 'kanban/1': { status: 'todo' } },
    })

    const tool = createReindexTool(deps)
    const result = await tool.execute({ workspaceId: WORKSPACE_ID })

    expect(result).toEqual({ reindexed: true, canvasCount: 1 })
    expect(workspaceIndex.applyRowsCalls.at(-1)?.facets).toEqual([
      { facet: 'facets.kanban/1', value: '', canvasId: CANVAS_ID },
    ])
  })
})
