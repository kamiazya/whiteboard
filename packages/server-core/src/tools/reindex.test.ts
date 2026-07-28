import { chunkSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { WorkspaceTree, writeFacets } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import * as logModule from '../log.js'
import type { ServerDeps } from '../server-deps.js'
import { createInMemoryCanvasDocStore } from '../test-utils/in-memory-canvas-doc-store.js'
import { createInMemoryWorkspaceIndex } from '../test-utils/in-memory-workspace-index.js'
import { reindexAllWorkspaces, reindexWorkspace } from './reindex.js'
import { saveWorkspaceTree } from './workspace-tree-io.js'

const MAX_CHUNK_BYTES = 1_000_000

function makeDeps(): ServerDeps {
  return {
    canvasDocStore: createInMemoryCanvasDocStore(),
    workspaceIndex: createInMemoryWorkspaceIndex(),
    blobStore: {} as never,
  }
}

async function saveCanvasWithFacets(
  deps: ServerDeps,
  canvasId: string,
  facets: Record<string, unknown>,
): Promise<void> {
  const doc = new LoroDoc()
  writeFacets(doc, facets)
  const { manifest, chunks } = chunkSnapshot(doc.export({ mode: 'snapshot' }), MAX_CHUNK_BYTES)
  await deps.canvasDocStore.saveSnapshot({
    docRef: { kind: 'canvas', canvasId },
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

async function createWorkspaceWithCanvas(
  deps: ServerDeps,
  workspaceId: string,
  segment: string,
): Promise<string> {
  const tree = new WorkspaceTree(new LoroDoc())
  const canvasId = `canvas-${segment}`
  tree.createNode(canvasId, segment)
  await saveWorkspaceTree(deps.canvasDocStore, workspaceId, tree)
  return canvasId
}

describe('reindexWorkspace', () => {
  it('applies rows reflecting every canvas currently in the workspace', async () => {
    const deps = makeDeps()
    const canvasId = await createWorkspaceWithCanvas(deps, 'ws-1', 'doc-a')
    await saveCanvasWithFacets(deps, canvasId, { 'example/1': { hello: 'world' } })

    await reindexWorkspace(deps, 'ws-1')

    const listed = await deps.workspaceIndex.listCanvases({ workspaceId: 'ws-1' })
    expect(listed.rows.map((row) => row.canvasId)).toEqual([canvasId])

    const facetHit = await deps.workspaceIndex.queryFacet({
      workspaceId: 'ws-1',
      facet: 'facets.example/1',
      value: '',
    })
    expect(facetHit.canvasIds).toEqual([canvasId])
  })

  it('applies empty rows (clearing stale state) for a workspace with zero canvases', async () => {
    const deps = makeDeps()
    // Prime the index with stale rows from a previous (now-gone) canvas.
    await deps.workspaceIndex.applyRows({
      workspaceId: 'ws-empty',
      canvasList: [{ canvasId: 'stale', title: 'stale', updatedAtMs: 0 }],
      facets: [],
      aliases: [],
      backlinks: [],
      aliasHistory: [],
    })

    await reindexWorkspace(deps, 'ws-empty')

    const listed = await deps.workspaceIndex.listCanvases({ workspaceId: 'ws-empty' })
    expect(listed.rows).toEqual([])
  })

  it('produces a canvas-list row with the tree segment as title when no doc was ever saved', async () => {
    const deps = makeDeps()
    const canvasId = await createWorkspaceWithCanvas(deps, 'ws-1', 'orphan-segment')

    await reindexWorkspace(deps, 'ws-1')

    const listed = await deps.workspaceIndex.listCanvases({ workspaceId: 'ws-1' })
    expect(listed.rows).toEqual([
      { canvasId, title: 'orphan-segment', updatedAtMs: expect.any(Number) },
    ])
  })

  it('skips a canvas whose doc snapshot cannot be reassembled instead of aborting the whole reindex', async () => {
    const deps = makeDeps()
    const goodCanvasId = await createWorkspaceWithCanvas(deps, 'ws-1', 'good')
    const badTree = new WorkspaceTree(new LoroDoc())
    // Reuse the already-created tree rather than a fresh one so both nodes
    // land under the same workspace.
    const existingTree = await import('./workspace-tree-io.js').then((m) =>
      m.loadWorkspaceTree(deps.canvasDocStore, 'ws-1'),
    )
    existingTree.createNode('canvas-corrupt', 'corrupt')
    await saveWorkspaceTree(deps.canvasDocStore, 'ws-1', existingTree)
    void badTree

    // A manifest claiming more chunks than are actually stored makes
    // `reassembleSnapshot` throw when this canvas doc is loaded.
    await deps.canvasDocStore.saveSnapshot({
      docRef: { kind: 'canvas', canvasId: 'canvas-corrupt' },
      manifest: { chunkCount: 1, totalBytes: 10, maxChunkBytes: 1_000_000 },
      chunks: [{ index: 0, of: 1, bytes: new Uint8Array([1, 2, 3]) }],
      frontier: new Uint8Array(),
    })

    await expect(reindexWorkspace(deps, 'ws-1')).resolves.toBeUndefined()

    const listed = await deps.workspaceIndex.listCanvases({ workspaceId: 'ws-1' })
    expect(listed.rows.map((row) => row.canvasId)).toEqual([goodCanvasId])
  })

  it('logs at error level and does not throw when applyRows rejects', async () => {
    const deps = makeDeps()
    await createWorkspaceWithCanvas(deps, 'ws-1', 'doc-a')
    const errorSpy = vi.fn()
    logModule.setLogSink((record) => {
      if (record.level === 'error') errorSpy(record)
    })
    deps.workspaceIndex.applyRows = vi.fn().mockRejectedValue(new Error('write failed'))

    await expect(reindexWorkspace(deps, 'ws-1')).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'reindex',
        level: 'error',
        msg: expect.stringContaining('apply workspace index rows'),
      }),
    )
    logModule.setLogSink(() => {})
  })
})

describe('reindexAllWorkspaces', () => {
  it('backfills every listed workspace', async () => {
    const deps = makeDeps()
    const canvasA = await createWorkspaceWithCanvas(deps, 'ws-a', 'doc-a')
    const canvasB = await createWorkspaceWithCanvas(deps, 'ws-b', 'doc-b')

    await reindexAllWorkspaces(deps, ['ws-a', 'ws-b'])

    const listedA = await deps.workspaceIndex.listCanvases({ workspaceId: 'ws-a' })
    const listedB = await deps.workspaceIndex.listCanvases({ workspaceId: 'ws-b' })
    expect(listedA.rows.map((r) => r.canvasId)).toEqual([canvasA])
    expect(listedB.rows.map((r) => r.canvasId)).toEqual([canvasB])
  })
})
