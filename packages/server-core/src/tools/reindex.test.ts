import type {
  ApplyRowsInput,
  CanvasDocStore,
  WorkspaceIndex,
} from '@kamiazya/whiteboard-canvas-ports'
import { WorkspaceTree } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { createInMemoryCanvasDocStore } from '../test-utils/in-memory-canvas-doc-store.js'
import { createFacetSetTool } from './facet-set.js'
import { reindexWorkspace } from './reindex.js'
import { saveWorkspaceTree } from './workspace-tree-io.js'

const WORKSPACE_ID = 'ws-1'
const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

class RecordingWorkspaceIndex implements WorkspaceIndex {
  readonly calls: ApplyRowsInput[] = []

  async applyRows(input: ApplyRowsInput): Promise<void> {
    this.calls.push(input)
  }

  async resolveAlias(): Promise<never> {
    throw new Error('not implemented')
  }

  async resolveAliasHistory(): Promise<never> {
    throw new Error('not implemented')
  }

  async listCanvases(): Promise<never> {
    throw new Error('not implemented')
  }

  async queryFacet(): Promise<never> {
    throw new Error('not implemented')
  }

  async listBacklinks(): Promise<never> {
    throw new Error('not implemented')
  }
}

function makeDeps(canvasDocStore: CanvasDocStore, workspaceIndex: WorkspaceIndex) {
  return { canvasDocStore, workspaceIndex, blobStore: {} as never }
}

describe('reindexWorkspace', () => {
  test('applies empty rows for a workspace with no tree nodes', async () => {
    const canvasDocStore = createInMemoryCanvasDocStore()
    const workspaceIndex = new RecordingWorkspaceIndex()

    await reindexWorkspace(makeDeps(canvasDocStore, workspaceIndex), WORKSPACE_ID)

    expect(workspaceIndex.calls).toHaveLength(1)
    expect(workspaceIndex.calls[0]).toEqual({
      workspaceId: WORKSPACE_ID,
      canvasList: [],
      facets: [],
      aliases: [],
      backlinks: [],
      aliasHistory: [],
    })
  })

  test('derives canvas list, alias, and facet rows from a saved tree + canvas doc', async () => {
    const canvasDocStore = createInMemoryCanvasDocStore()
    const workspaceIndex = new RecordingWorkspaceIndex()

    const tree = new WorkspaceTree(new LoroDoc())
    tree.createNode(CANVAS_ID, 'my-canvas')
    await saveWorkspaceTree(canvasDocStore, WORKSPACE_ID, tree)

    const deps = makeDeps(canvasDocStore, workspaceIndex)
    const facetSet = createFacetSetTool(deps)
    await facetSet.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      facets: { 'kanban/1': { status: 'todo' } },
    })

    // facet_set already triggers its own reindex; this call is redundant but
    // must be idempotent against unchanged state.
    await reindexWorkspace(deps, WORKSPACE_ID)

    expect(workspaceIndex.calls).toHaveLength(2)
    const applied = workspaceIndex.calls[1]
    expect(applied.workspaceId).toBe(WORKSPACE_ID)
    expect(applied.canvasList).toEqual([
      { canvasId: CANVAS_ID, title: 'my-canvas', updatedAtMs: expect.any(Number) },
    ])
    expect(applied.aliases).toEqual([{ alias: 'my-canvas', canvasId: CANVAS_ID }])
    expect(applied.facets).toEqual([{ facet: 'facets.kanban/1', value: '', canvasId: CANVAS_ID }])
  })

  test('skips a tree node whose canvas has no saved snapshot yet', async () => {
    const canvasDocStore = createInMemoryCanvasDocStore()
    const workspaceIndex = new RecordingWorkspaceIndex()

    const tree = new WorkspaceTree(new LoroDoc())
    tree.createNode(CANVAS_ID, 'unsaved-canvas')
    await saveWorkspaceTree(canvasDocStore, WORKSPACE_ID, tree)

    await reindexWorkspace(makeDeps(canvasDocStore, workspaceIndex), WORKSPACE_ID)

    const applied = workspaceIndex.calls[0]
    expect(applied.facets).toEqual([])
    // the alias row is still derived from the tree itself, independent of doc state
    expect(applied.aliases).toEqual([{ alias: 'unsaved-canvas', canvasId: CANVAS_ID }])
    expect(applied.canvasList).toEqual([])
  })
})
