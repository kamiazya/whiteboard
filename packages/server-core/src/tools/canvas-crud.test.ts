import { canvasIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { WorkspaceTree } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { createInMemoryCanvasDocStore } from '../test-utils/in-memory-canvas-doc-store.js'
import { unusedDocumentIndex } from '../test-utils/unused-document-index.js'
import {
  CanvasNotFoundError,
  CanvasParentNotFoundError,
  CanvasSegmentConflictError,
  WorkspaceNotFoundError,
} from './canvas-crud.errors.js'
import { wbCanvasCreate, wbCanvasDelete, wbCanvasGet, wbCanvasList } from './canvas-crud.js'
import { saveWorkspaceTree } from './workspace-tree-io.js'

function makeDeps(): ServerDeps {
  return {
    canvasDocStore: createInMemoryCanvasDocStore(),
    blobStore: {} as never,
    documentIndex: unusedDocumentIndex(),
  }
}

describe('wbCanvasCreate', () => {
  it('creates a canvas and returns canvasId + segment', async () => {
    const deps = makeDeps()
    const result = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-a',
      kind: 'spatial',
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
      kind: 'spatial',
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
      kind: 'spatial',
      parentId: parentTreeNode?.id,
    })
    const childNode = await wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: child.canvasId })
    expect(childNode.alias).toBe('folder/child')
  })

  it('throws CanvasSegmentConflictError when a sibling with the same segment already exists', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    await expect(
      wbCanvasCreate(deps, { workspaceId: 'ws-1', segment: 'doc-a', kind: 'spatial' }),
    ).rejects.toThrow(CanvasSegmentConflictError)
  })

  it('throws CanvasParentNotFoundError when parentId does not exist', async () => {
    const deps = makeDeps()
    await expect(
      wbCanvasCreate(deps, {
        workspaceId: 'ws-1',
        segment: 'doc-a',
        kind: 'spatial',
        parentId: 'does-not-exist',
        createWorkspace: true,
      }),
    ).rejects.toThrow(CanvasParentNotFoundError)
  })

  it('throws WorkspaceNotFoundError for an unknown workspaceId without createWorkspace, and list agrees', async () => {
    const deps = makeDeps()
    await expect(
      wbCanvasCreate(deps, { workspaceId: 'typo-probe-ws', segment: 'doc-a', kind: 'spatial' }),
    ).rejects.toThrow(WorkspaceNotFoundError)
    // LIST and CREATE must derive workspace existence from the same signal —
    // a typo'd workspace id should not look like an empty workspace.
    await expect(wbCanvasList(deps, { workspaceId: 'typo-probe-ws' })).rejects.toThrow(
      WorkspaceNotFoundError,
    )
  })

  it('materializes the workspace when createWorkspace: true is passed', async () => {
    const deps = makeDeps()
    const created = await wbCanvasCreate(deps, {
      workspaceId: 'brand-new-ws',
      segment: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    expect(created.segment).toBe('doc-a')
    const listed = await wbCanvasList(deps, { workspaceId: 'brand-new-ws' })
    expect(listed.canvases.map((c) => c.canvasId)).toContain(created.canvasId)
  })

  it('succeeds without the flag when the workspace already exists', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    const second = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-b',
      kind: 'spatial',
    })
    expect(second.segment).toBe('doc-b')
  })
})

describe('wbCanvasGet', () => {
  it('returns the canvas with its resolved alias after create', async () => {
    const deps = makeDeps()
    const created = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-a',
      kind: 'spatial',
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
  it('throws WorkspaceNotFoundError for a workspace that was never created', async () => {
    const deps = makeDeps()
    await expect(wbCanvasList(deps, { workspaceId: 'ws-1' })).rejects.toThrow(
      WorkspaceNotFoundError,
    )
  })

  it('returns an empty list for a workspace that was created but has no canvases', async () => {
    const deps = makeDeps()
    // Materialize the workspace tree without creating any canvas — existence
    // is persisted-tree existence, never non-emptiness.
    await saveWorkspaceTree(deps.canvasDocStore, 'ws-1', new WorkspaceTree(new LoroDoc()))
    const result = await wbCanvasList(deps, { workspaceId: 'ws-1' })
    expect(result.canvases).toEqual([])
  })

  it('returns all created canvases with resolved aliases', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    await wbCanvasCreate(deps, { workspaceId: 'ws-1', segment: 'doc-b', kind: 'spatial' })
    const result = await wbCanvasList(deps, { workspaceId: 'ws-1' })
    expect(result.canvases).toHaveLength(2)
    expect(result.canvases.map((c) => c.alias).sort()).toEqual(['doc-a', 'doc-b'])
  })

  it('excludes a deleted canvas', async () => {
    const deps = makeDeps()
    const created = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    await wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: created.canvasId })
    const result = await wbCanvasList(deps, { workspaceId: 'ws-1' })
    expect(result.canvases).toEqual([])
  })

  it('disambiguates a merge-produced duplicate sibling into a unique alias (ADR-0008 point 5)', async () => {
    const deps = makeDeps()

    // Two peers each create a root canvas segment 'notes' independently,
    // then merge — the real CRDT production shape that
    // #assertNoSiblingConflict cannot see coming, since it only guards a
    // single doc's own local mutations.
    const doc1 = new LoroDoc()
    const tree1 = new WorkspaceTree(doc1)
    tree1.createNode('canvas-b', 'notes')

    const doc2 = new LoroDoc()
    const tree2 = new WorkspaceTree(doc2)
    tree2.createNode('canvas-a', 'notes')

    doc1.import(doc2.export({ mode: 'snapshot' }))
    const merged = new WorkspaceTree(doc1)
    await saveWorkspaceTree(deps.canvasDocStore, 'ws-1', merged)

    const listed = await wbCanvasList(deps, { workspaceId: 'ws-1' })
    expect(listed.canvases).toHaveLength(2)
    expect(listed.canvases.map((c) => c.alias).sort()).toEqual(['notes', 'notes-2'])

    const winner = await wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: 'canvas-a' })
    expect(winner.alias).toBe('notes')
    const loser = await wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: 'canvas-b' })
    expect(loser.alias).toBe('notes-2')
  })
})

describe('wbCanvasDelete', () => {
  it('deletes a canvas so a later get throws CanvasNotFoundError', async () => {
    const deps = makeDeps()
    const created = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    const result = await wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: created.canvasId })
    expect(result).toEqual({ deleted: true })
    await expect(
      wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: created.canvasId }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  it('deletes the stored document, not only its place in the tree', async () => {
    // Removing the tree node makes the document unreachable, which reads as
    // deleted and leaves its snapshot behind for good. Nothing else ever
    // refers to that id again, so the bytes are unreferenced rather than
    // merely orphaned — and deletion is how a resolved item is closed, so
    // the store grows once per completed piece of work.
    const deps = makeDeps()
    const created = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    const docRef = { kind: 'canvas', canvasId: created.canvasId } as const
    expect(await deps.canvasDocStore.loadSnapshot({ docRef })).not.toBeNull()

    await wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: created.canvasId })

    expect(await deps.canvasDocStore.loadSnapshot({ docRef })).toBeNull()
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
      kind: 'spatial',
      createWorkspace: true,
    })
    const tree = await loadTreeForAssertions(deps)
    const parentTreeNode = tree.snapshot().nodes.find((n) => n.canvasId === parent.canvasId)
    const child = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'child',
      kind: 'spatial',
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

describe('document name', () => {
  // ADR-0009: the name lives in the workspace, not in the document's content.
  // Until this, creation took a `segment` only — a slug — so a document had
  // no name of its own and every reader fell back to showing the slug.
  it('creation accepts a name and the listing returns it', async () => {
    const deps = makeDeps()
    const { canvasId } = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'release-plan',
      kind: 'markdown',
      createWorkspace: true,
      name: 'リリース計画 2026',
    })

    const { canvases } = await wbCanvasList(deps, { workspaceId: 'ws-1' })

    expect(canvases).toEqual([
      { canvasId, segment: 'release-plan', alias: 'release-plan', name: 'リリース計画 2026' },
    ])
  })

  it('omits the name entirely when none was given, rather than echoing the segment', async () => {
    // A reader that wants a fallback can choose one; a listing that invents
    // `name: 'release-plan'` takes that choice away and reads as if someone
    // typed the slug as the title.
    const deps = makeDeps()
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'release-plan',
      kind: 'markdown',
      createWorkspace: true,
    })

    const { canvases } = await wbCanvasList(deps, { workspaceId: 'ws-1' })

    expect(canvases[0]).not.toHaveProperty('name')
  })

  it('a name is free text, not a second segment', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'plan',
      kind: 'markdown',
      createWorkspace: true,
      name: 'Release plan 2026 / v2 (draft)',
    })

    const { canvases } = await wbCanvasList(deps, { workspaceId: 'ws-1' })

    expect(canvases[0]?.name).toBe('Release plan 2026 / v2 (draft)')
    expect(canvases[0]?.segment).toBe('plan')
  })

  it('wbCanvasGet returns the name too', async () => {
    const deps = makeDeps()
    const { canvasId } = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      segment: 'doc',
      kind: 'markdown',
      createWorkspace: true,
      name: 'Doc one',
    })

    await expect(wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId })).resolves.toMatchObject({
      name: 'Doc one',
    })
  })
})
