import { describe, expect, it } from 'vitest'
import { createInMemoryCanvasDocStore } from '../test-utils/in-memory-canvas-doc-store.js'
import { loadWorkspaceTree, saveWorkspaceTree } from './workspace-tree-io.js'

describe('loadWorkspaceTree', () => {
  it('returns an empty tree when no snapshot has been saved yet', async () => {
    const store = createInMemoryCanvasDocStore()
    const tree = await loadWorkspaceTree(store, 'ws-1')
    expect(tree.snapshot().nodes).toHaveLength(0)
  })
})

describe('saveWorkspaceTree + loadWorkspaceTree round-trip', () => {
  it('persists tree mutations across a save/load cycle', async () => {
    const store = createInMemoryCanvasDocStore()
    const tree = await loadWorkspaceTree(store, 'ws-1')
    tree.createNode('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'doc-a')
    await saveWorkspaceTree(store, 'ws-1', tree)

    const reloaded = await loadWorkspaceTree(store, 'ws-1')
    expect(reloaded.snapshot().nodes).toHaveLength(1)
    expect(reloaded.snapshot().nodes[0]?.segment).toBe('doc-a')
  })

  it('keeps distinct workspaces isolated', async () => {
    const store = createInMemoryCanvasDocStore()
    const treeA = await loadWorkspaceTree(store, 'ws-a')
    treeA.createNode('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'a-doc')
    await saveWorkspaceTree(store, 'ws-a', treeA)

    const treeB = await loadWorkspaceTree(store, 'ws-b')
    expect(treeB.snapshot().nodes).toHaveLength(0)
  })
})
