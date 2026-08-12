import { canvasIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { createInMemoryCanvasDocStore } from '../test-utils/in-memory-canvas-doc-store.js'
import {
  CanvasNotFoundError,
  CanvasParentNotFoundError,
  CanvasSegmentConflictError,
  WorkspaceNotFoundError,
} from './canvas-crud.errors.js'
import { wbCanvasCreate, wbCanvasDelete, wbCanvasGet, wbCanvasList } from './canvas-crud.js'

function makeDeps(): ServerDeps {
  return {
    canvasDocStore: createInMemoryCanvasDocStore(),
    blobStore: {} as never,
  }
}

describe('wbCanvasCreate', () => {
  it('creates a canvas and returns canvasId + segment', async () => {
    const deps = makeDeps()
    const result = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-a',
      createWorkspace: true,
    })
    expect(result.segment).toBe('doc-a')
    expect(() => canvasIdSchema.parse(result.canvasId)).not.toThrow()
  })

  it('creates a nested canvas under an existing parent and the alias reflects nesting', async () => {
    const deps = makeDeps()
    const parent = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'folder',
      createWorkspace: true,
    })
    const parentNode = await wbCanvasGet(deps, {
      workspaceId: 'ws-1',
      canvasId: parent.canvasId,
    })
    expect(parentNode.alias).toBe('folder')

    const tree = await loadTreeForAssertions(deps)
    const parentTreeNode = tree.snapshot().nodes.find((n) => n.canvasId === parent.canvasId)
    const child = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'child',
      parentId: parentTreeNode?.id,
    })
    const childNode = await wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: child.canvasId })
    expect(childNode.alias).toBe('folder/child')
  })

  it('throws CanvasSegmentConflictError when a sibling with the same segment already exists', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, { workspaceId: 'ws-1', segment: 'doc-a', createWorkspace: true })
    await expect(wbCanvasCreate(deps, { workspaceId: 'ws-1', segment: 'doc-a' })).rejects.toThrow(
      CanvasSegmentConflictError,
    )
  })

  it('throws CanvasParentNotFoundError when parentId does not exist', async () => {
    const deps = makeDeps()
    await expect(
      wbCanvasCreate(deps, {
        workspaceId: 'ws-1',
        segment: 'doc-a',
        parentId: 'does-not-exist',
        createWorkspace: true,
      }),
    ).rejects.toThrow(CanvasParentNotFoundError)
  })

  it('throws WorkspaceNotFoundError for an unknown workspaceId without createWorkspace', async () => {
    const deps = makeDeps()
    await expect(
      wbCanvasCreate(deps, { workspaceId: 'typo-probe-ws', segment: 'doc-a' }),
    ).rejects.toThrow(WorkspaceNotFoundError)
    const listed = await wbCanvasList(deps, { workspaceId: 'typo-probe-ws' })
    expect(listed.canvases).toEqual([])
  })

  it('materializes the workspace when createWorkspace: true is passed', async () => {
    const deps = makeDeps()
    const created = await wbCanvasCreate(deps, {
      workspaceId: 'brand-new-ws',
      segment: 'doc-a',
      createWorkspace: true,
    })
    expect(created.segment).toBe('doc-a')
    const listed = await wbCanvasList(deps, { workspaceId: 'brand-new-ws' })
    expect(listed.canvases.map((c) => c.canvasId)).toContain(created.canvasId)
  })

  it('succeeds without the flag when the workspace already exists', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, { workspaceId: 'ws-1', segment: 'doc-a', createWorkspace: true })
    const second = await wbCanvasCreate(deps, { workspaceId: 'ws-1', segment: 'doc-b' })
    expect(second.segment).toBe('doc-b')
  })
})

describe('wbCanvasGet', () => {
  it('returns the canvas with its resolved alias after create', async () => {
    const deps = makeDeps()
    const created = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-a',
      createWorkspace: true,
    })
    const result = await wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: created.canvasId })
    expect(result).toEqual({ canvasId: created.canvasId, segment: 'doc-a', alias: 'doc-a' })
  })

  it('throws CanvasNotFoundError for a canvasId that does not exist', async () => {
    const deps = makeDeps()
    await expect(
      wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ).rejects.toThrow(CanvasNotFoundError)
  })
})

describe('wbCanvasList', () => {
  it('returns an empty list for an empty workspace', async () => {
    const deps = makeDeps()
    const result = await wbCanvasList(deps, { workspaceId: 'ws-1' })
    expect(result.canvases).toEqual([])
  })

  it('returns all created canvases with resolved aliases', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, { workspaceId: 'ws-1', segment: 'doc-a', createWorkspace: true })
    await wbCanvasCreate(deps, { workspaceId: 'ws-1', segment: 'doc-b' })
    const result = await wbCanvasList(deps, { workspaceId: 'ws-1' })
    expect(result.canvases).toHaveLength(2)
    expect(result.canvases.map((c) => c.alias).sort()).toEqual(['doc-a', 'doc-b'])
  })

  it('excludes a deleted canvas', async () => {
    const deps = makeDeps()
    const created = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-a',
      createWorkspace: true,
    })
    await wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: created.canvasId })
    const result = await wbCanvasList(deps, { workspaceId: 'ws-1' })
    expect(result.canvases).toEqual([])
  })
})

describe('wbCanvasDelete', () => {
  it('deletes a canvas so a later get throws CanvasNotFoundError', async () => {
    const deps = makeDeps()
    const created = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-a',
      createWorkspace: true,
    })
    const result = await wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: created.canvasId })
    expect(result).toEqual({ deleted: true })
    await expect(
      wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: created.canvasId }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  it('throws CanvasNotFoundError when deleting a non-existent canvasId', async () => {
    const deps = makeDeps()
    await expect(
      wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  it('deletes a canvas that has children without throwing, and the child no longer resolves', async () => {
    const deps = makeDeps()
    const parent = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'folder',
      createWorkspace: true,
    })
    const tree = await loadTreeForAssertions(deps)
    const parentTreeNode = tree.snapshot().nodes.find((n) => n.canvasId === parent.canvasId)
    const child = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'child',
      parentId: parentTreeNode?.id,
    })

    await expect(
      wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: parent.canvasId }),
    ).resolves.toEqual({ deleted: true })

    await expect(
      wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: child.canvasId }),
    ).rejects.toThrow(CanvasNotFoundError)
  })
})

// Test-only helper: reaches into the persisted tree to obtain a real TreeID
// for nesting scenarios, since wbCanvasCreate's output intentionally does
// not expose TreeID (only canvasId, a stable public identifier).
async function loadTreeForAssertions(deps: ServerDeps) {
  const { loadWorkspaceTree } = await import('./workspace-tree-io.js')
  return loadWorkspaceTree(deps.canvasDocStore, 'ws-1')
}
