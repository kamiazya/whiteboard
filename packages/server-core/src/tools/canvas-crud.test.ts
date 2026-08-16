import { canvasIdSchema } from '@kamiazya/whiteboard-canvas-model'
import {
  DocumentHasDescendantsError,
  DocumentPathTakenError,
} from '@kamiazya/whiteboard-canvas-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-canvas-ports/test-utils'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { CanvasNotFoundError, WorkspaceNotFoundError } from './canvas-crud.errors.js'
import { wbCanvasCreate, wbCanvasDelete, wbCanvasGet, wbCanvasList } from './canvas-crud.js'

function makeDeps(): ServerDeps {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
  }
}

describe('wbCanvasCreate', () => {
  it('creates a document and returns canvasId + path', async () => {
    const deps = makeDeps()
    const result = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    expect(result.path).toBe('doc-a')
    expect(() => canvasIdSchema.parse(result.canvasId)).not.toThrow()
  })

  it('nests by path, with no parent id involved', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent',
      kind: 'spatial',
      createWorkspace: true,
    })
    const child = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent/child',
      kind: 'spatial',
    })
    expect(child.path).toBe('parent/child')

    // The hierarchy is readable from the listing without resolving anything:
    // a path sorts before every path it prefixes.
    const { canvases } = await wbCanvasList(deps, { workspaceId: 'ws-1' })
    expect(canvases.map((c) => c.path)).toEqual(['parent', 'parent/child'])
  })

  it('refuses a path that is already taken', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    await expect(
      wbCanvasCreate(deps, { workspaceId: 'ws-1', path: 'doc-a', kind: 'markdown' }),
    ).rejects.toThrow(DocumentPathTakenError)
  })

  it('throws WorkspaceNotFoundError for an unknown workspaceId, and list agrees', async () => {
    const deps = makeDeps()
    await expect(
      wbCanvasCreate(deps, { workspaceId: 'nope', path: 'doc-a', kind: 'spatial' }),
    ).rejects.toThrow(WorkspaceNotFoundError)
    await expect(wbCanvasList(deps, { workspaceId: 'nope' })).rejects.toThrow(
      WorkspaceNotFoundError,
    )
  })

  it('materializes the workspace when createWorkspace: true is passed', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-new',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    const { canvases } = await wbCanvasList(deps, { workspaceId: 'ws-new' })
    expect(canvases).toHaveLength(1)
  })

  it('succeeds without the flag once the workspace exists', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'first',
      kind: 'spatial',
      createWorkspace: true,
    })
    const second = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'second',
      kind: 'spatial',
    })
    expect(second.path).toBe('second')
  })
})

describe('wbCanvasGet', () => {
  it('returns the document with its path', async () => {
    const deps = makeDeps()
    const created = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent/child',
      kind: 'spatial',
      createWorkspace: true,
    })
    const got = await wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: created.canvasId })
    expect(got).toEqual({ canvasId: created.canvasId, path: 'parent/child' })
  })

  it('throws CanvasNotFoundError for a canvasId that does not exist', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    await expect(
      wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  it('does not resolve a document from another workspace', async () => {
    const deps = makeDeps()
    const mine = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-2',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    // An id is a handle within a workspace, not a capability that reaches
    // across them.
    await expect(
      wbCanvasGet(deps, { workspaceId: 'ws-2', canvasId: mine.canvasId }),
    ).rejects.toThrow(CanvasNotFoundError)
  })
})

describe('wbCanvasList', () => {
  it('throws WorkspaceNotFoundError for a workspace that was never created', async () => {
    const deps = makeDeps()
    await expect(wbCanvasList(deps, { workspaceId: 'ghost' })).rejects.toThrow(
      WorkspaceNotFoundError,
    )
  })

  it('returns an empty list for a workspace that exists and holds nothing', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'only',
      kind: 'spatial',
      createWorkspace: true,
    })
    await wbCanvasDelete(deps, {
      workspaceId: 'ws-1',
      canvasId: (await wbCanvasList(deps, { workspaceId: 'ws-1' })).canvases[0]!.canvasId,
    })
    expect((await wbCanvasList(deps, { workspaceId: 'ws-1' })).canvases).toEqual([])
  })

  it('returns every document, ordered so each subtree stays together', async () => {
    const deps = makeDeps()
    for (const path of ['b-side', 'a', 'a/deep', 'a-sibling']) {
      await wbCanvasCreate(deps, {
        workspaceId: 'ws-1',
        path,
        kind: 'spatial',
        createWorkspace: true,
      })
    }
    const { canvases } = await wbCanvasList(deps, { workspaceId: 'ws-1' })
    // `a-sibling` after `a/deep`, because comparing whole strings would put
    // it between `a` and its own child and split the subtree apart.
    expect(canvases.map((c) => c.path)).toEqual(['a', 'a/deep', 'a-sibling', 'b-side'])
  })

  it('excludes a deleted document', async () => {
    const deps = makeDeps()
    const keep = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'keep',
      kind: 'spatial',
      createWorkspace: true,
    })
    const drop = await wbCanvasCreate(deps, { workspaceId: 'ws-1', path: 'drop', kind: 'spatial' })
    await wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: drop.canvasId })

    const { canvases } = await wbCanvasList(deps, { workspaceId: 'ws-1' })
    expect(canvases.map((c) => c.canvasId)).toEqual([keep.canvasId])
  })
})

describe('wbCanvasDelete', () => {
  it('deletes a document so a later get throws CanvasNotFoundError', async () => {
    const deps = makeDeps()
    const created = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    expect(await wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: created.canvasId })).toEqual(
      {
        deleted: true,
      },
    )
    await expect(
      wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: created.canvasId }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  it('deletes the stored document, not only its placement', async () => {
    const deps = makeDeps()
    const created = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    const docRef = { kind: 'canvas', canvasId: created.canvasId } as const
    expect(await deps.documentStore.loadSnapshot({ docRef })).not.toBeNull()

    await wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: created.canvasId })

    expect(await deps.documentStore.loadSnapshot({ docRef })).toBeNull()
  })

  it('throws CanvasNotFoundError when deleting a canvasId that does not exist', async () => {
    const deps = makeDeps()
    await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    await expect(
      wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  it('refuses to delete a document that still has documents below it', async () => {
    const deps = makeDeps()
    const parent = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent',
      kind: 'spatial',
      createWorkspace: true,
    })
    const child = await wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent/child',
      kind: 'spatial',
    })

    // Deleting the parent used to orphan the child silently. Deletion has
    // nothing to undo it, so the caller has to name what it destroys.
    await expect(
      wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: parent.canvasId }),
    ).rejects.toThrow(DocumentHasDescendantsError)
    expect(await wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: parent.canvasId })).toBeTruthy()

    await wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: child.canvasId })
    await wbCanvasDelete(deps, { workspaceId: 'ws-1', canvasId: parent.canvasId })
    expect((await wbCanvasList(deps, { workspaceId: 'ws-1' })).canvases).toEqual([])
  })
})

describe('document name', () => {
  async function createNamed(deps: ServerDeps, name?: string) {
    return wbCanvasCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
      ...(name === undefined ? {} : { name }),
    })
  }

  it('creation accepts a name and the listing returns it', async () => {
    const deps = makeDeps()
    await createNamed(deps, 'Quarterly plan')
    const { canvases } = await wbCanvasList(deps, { workspaceId: 'ws-1' })
    expect(canvases[0]?.name).toBe('Quarterly plan')
  })

  it('omits the name entirely when none was given, rather than echoing the path', async () => {
    const deps = makeDeps()
    await createNamed(deps)
    const { canvases } = await wbCanvasList(deps, { workspaceId: 'ws-1' })
    expect(canvases[0]).toBeDefined()
    expect('name' in (canvases[0] as object)).toBe(false)
  })

  it('a name is free text, not a second path', async () => {
    const deps = makeDeps()
    const created = await createNamed(deps, 'Q3 / plan — draft')
    const got = await wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: created.canvasId })
    expect(got.name).toBe('Q3 / plan — draft')
    // The name never becomes placement: the path is still what was asked for.
    expect(got.path).toBe('doc-a')
  })

  it('wbCanvasGet returns the name too', async () => {
    const deps = makeDeps()
    const created = await createNamed(deps, 'Named')
    const got = await wbCanvasGet(deps, { workspaceId: 'ws-1', canvasId: created.canvasId })
    expect(got.name).toBe('Named')
  })
})
