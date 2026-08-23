import { documentIdSchema } from '@kamiazya/whiteboard-model'
import { DocumentHasDescendantsError, DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { WorkspaceDocumentNotFoundError, WorkspaceNotFoundError } from './document-crud.errors.js'
import {
  wbDocumentCreate,
  wbDocumentDelete,
  wbDocumentList,
  wbDocumentResolve,
} from './document-crud.js'

function makeDeps(): ServerDeps {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
  }
}

describe('wbDocumentCreate', () => {
  it('creates a document and returns documentId + path', async () => {
    const deps = makeDeps()
    const result = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    expect(result.path).toBe('doc-a')
    expect(() => documentIdSchema.parse(result.documentId)).not.toThrow()
  })

  it('nests by path, with no parent id involved', async () => {
    const deps = makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent',
      kind: 'spatial',
      createWorkspace: true,
    })
    const child = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent/child',
      kind: 'spatial',
    })
    expect(child.path).toBe('parent/child')

    // The hierarchy is readable from the listing without resolving anything:
    // a path sorts before every path it prefixes.
    const { documents } = await wbDocumentList(deps, { workspaceId: 'ws-1' })
    expect(documents.map((c) => c.path)).toEqual(['parent', 'parent/child'])
  })

  it('refuses a path that is already taken', async () => {
    const deps = makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    await expect(
      wbDocumentCreate(deps, { workspaceId: 'ws-1', path: 'doc-a', kind: 'markdown' }),
    ).rejects.toThrow(DocumentPathTakenError)
  })

  it('throws WorkspaceNotFoundError for an unknown workspaceId, and list agrees', async () => {
    const deps = makeDeps()
    await expect(
      wbDocumentCreate(deps, { workspaceId: 'nope', path: 'doc-a', kind: 'spatial' }),
    ).rejects.toThrow(WorkspaceNotFoundError)
    await expect(wbDocumentList(deps, { workspaceId: 'nope' })).rejects.toThrow(
      WorkspaceNotFoundError,
    )
  })

  it('materializes the workspace when createWorkspace: true is passed', async () => {
    const deps = makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-new',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    const { documents } = await wbDocumentList(deps, { workspaceId: 'ws-new' })
    expect(documents).toHaveLength(1)
  })

  it('succeeds without the flag once the workspace exists', async () => {
    const deps = makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'first',
      kind: 'spatial',
      createWorkspace: true,
    })
    const second = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'second',
      kind: 'spatial',
    })
    expect(second.path).toBe('second')
  })
})

describe('wbDocumentResolve', () => {
  it('returns the document with its path', async () => {
    const deps = makeDeps()
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent/child',
      kind: 'spatial',
      createWorkspace: true,
    })
    const got = await wbDocumentResolve(deps, {
      workspaceId: 'ws-1',
      documentId: created.documentId,
    })
    expect(got).toEqual({ documentId: created.documentId, path: 'parent/child' })
  })

  it('throws WorkspaceDocumentNotFoundError for a documentId that does not exist', async () => {
    const deps = makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    await expect(
      wbDocumentResolve(deps, { workspaceId: 'ws-1', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })

  it('does not resolve a document from another workspace', async () => {
    const deps = makeDeps()
    const mine = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-2',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    // An id is a handle within a workspace, not a capability that reaches
    // across them.
    await expect(
      wbDocumentResolve(deps, { workspaceId: 'ws-2', documentId: mine.documentId }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })
})

describe('wbDocumentList', () => {
  it('throws WorkspaceNotFoundError for a workspace that was never created', async () => {
    const deps = makeDeps()
    await expect(wbDocumentList(deps, { workspaceId: 'ghost' })).rejects.toThrow(
      WorkspaceNotFoundError,
    )
  })

  it('returns an empty list for a workspace that exists and holds nothing', async () => {
    const deps = makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'only',
      kind: 'spatial',
      createWorkspace: true,
    })
    await wbDocumentDelete(deps, {
      workspaceId: 'ws-1',
      documentId: (await wbDocumentList(deps, { workspaceId: 'ws-1' })).documents[0]!.documentId,
    })
    expect((await wbDocumentList(deps, { workspaceId: 'ws-1' })).documents).toEqual([])
  })

  it('returns every document, ordered so each subtree stays together', async () => {
    const deps = makeDeps()
    for (const path of ['b-side', 'a', 'a/deep', 'a-sibling']) {
      await wbDocumentCreate(deps, {
        workspaceId: 'ws-1',
        path,
        kind: 'spatial',
        createWorkspace: true,
      })
    }
    const { documents } = await wbDocumentList(deps, { workspaceId: 'ws-1' })
    // `a-sibling` after `a/deep`, because comparing whole strings would put
    // it between `a` and its own child and split the subtree apart.
    expect(documents.map((c) => c.path)).toEqual(['a', 'a/deep', 'a-sibling', 'b-side'])
  })

  it('excludes a deleted document', async () => {
    const deps = makeDeps()
    const keep = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'keep',
      kind: 'spatial',
      createWorkspace: true,
    })
    const drop = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'drop',
      kind: 'spatial',
    })
    await wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: drop.documentId })

    const { documents } = await wbDocumentList(deps, { workspaceId: 'ws-1' })
    expect(documents.map((c) => c.documentId)).toEqual([keep.documentId])
  })
})

describe('wbDocumentDelete', () => {
  it('deletes a document so a later get throws WorkspaceDocumentNotFoundError', async () => {
    const deps = makeDeps()
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    expect(
      await wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: created.documentId }),
    ).toEqual({
      deleted: true,
    })
    await expect(
      wbDocumentResolve(deps, { workspaceId: 'ws-1', documentId: created.documentId }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })

  it('deletes the stored document, not only its placement', async () => {
    const deps = makeDeps()
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    const docRef = { kind: 'document', documentId: created.documentId } as const
    expect(await deps.documentStore.loadSnapshot({ docRef })).not.toBeNull()

    await wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: created.documentId })

    expect(await deps.documentStore.loadSnapshot({ docRef })).toBeNull()
  })

  it('throws WorkspaceDocumentNotFoundError when deleting a documentId that does not exist', async () => {
    const deps = makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    await expect(
      wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })

  it('refuses to delete a document that still has documents below it', async () => {
    const deps = makeDeps()
    const parent = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent',
      kind: 'spatial',
      createWorkspace: true,
    })
    const child = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent/child',
      kind: 'spatial',
    })

    // Deleting the parent used to orphan the child silently. Deletion has
    // nothing to undo it, so the caller has to name what it destroys.
    await expect(
      wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: parent.documentId }),
    ).rejects.toThrow(DocumentHasDescendantsError)
    expect(
      await wbDocumentResolve(deps, { workspaceId: 'ws-1', documentId: parent.documentId }),
    ).toBeTruthy()

    await wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: child.documentId })
    await wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: parent.documentId })
    expect((await wbDocumentList(deps, { workspaceId: 'ws-1' })).documents).toEqual([])
  })
})

describe('document name', () => {
  async function createNamed(deps: ServerDeps, name?: string) {
    return wbDocumentCreate(deps, {
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
    const { documents } = await wbDocumentList(deps, { workspaceId: 'ws-1' })
    expect(documents[0]?.name).toBe('Quarterly plan')
  })

  it('omits the name entirely when none was given, rather than echoing the path', async () => {
    const deps = makeDeps()
    await createNamed(deps)
    const { documents } = await wbDocumentList(deps, { workspaceId: 'ws-1' })
    expect(documents[0]).toBeDefined()
    expect('name' in (documents[0] as object)).toBe(false)
  })

  it('a name is free text, not a second path', async () => {
    const deps = makeDeps()
    const created = await createNamed(deps, 'Q3 / plan — draft')
    const got = await wbDocumentResolve(deps, {
      workspaceId: 'ws-1',
      documentId: created.documentId,
    })
    expect(got.name).toBe('Q3 / plan — draft')
    // The name never becomes placement: the path is still what was asked for.
    expect(got.path).toBe('doc-a')
  })

  it('wbDocumentResolve returns the name too', async () => {
    const deps = makeDeps()
    const created = await createNamed(deps, 'Named')
    const got = await wbDocumentResolve(deps, {
      workspaceId: 'ws-1',
      documentId: created.documentId,
    })
    expect(got.name).toBe('Named')
  })
})

describe('wbDocumentDelete document teardown seam', () => {
  // The seam exists because a document is more than its index row and its
  // bytes: a composition root also holds thumbnails, blob files and a cached
  // doc instance, none of which server-core can name. Without it, a document
  // an agent deletes is not deleted the way one a human deletes is.
  function makeRecordingTeardown() {
    const events: string[] = []
    return {
      events,
      teardown: {
        async begin(input: { workspaceId: string; documentId: string; path: string }) {
          events.push(`begin:${input.workspaceId}:${input.path}:${input.documentId}`)
          return async () => {
            events.push('finalize')
          }
        },
      },
    }
  }

  it('begins teardown while the document still exists and finalizes after it is gone', async () => {
    const deps = makeDeps()
    const { events, teardown } = makeRecordingTeardown()
    deps.documentTeardown = teardown
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    const docRef = { kind: 'document', documentId: created.documentId } as const

    // Recorded from inside the seam, not asserted afterwards: whether the
    // row was still there AT begin is the whole point — a version's
    // thumbnail is filed under a version id that cascades away with it.
    const index = deps.documentIndex
    const store = deps.documentStore
    deps.documentTeardown = {
      async begin(input) {
        const stillIndexed = await index.resolveDocumentById({
          workspaceId: input.workspaceId,
          documentId: input.documentId,
        })
        events.push(`begin:indexed=${stillIndexed !== null}`)
        return async () => {
          events.push(
            `finalize:indexed=${
              (await index.resolveDocumentById({
                workspaceId: input.workspaceId,
                documentId: input.documentId,
              })) !== null
            }`,
          )
          events.push(`finalize:snapshot=${(await store.loadSnapshot({ docRef })) !== null}`)
        }
      },
    }

    await wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: created.documentId })

    expect(events).toEqual([
      'begin:indexed=true',
      'finalize:indexed=false',
      'finalize:snapshot=false',
    ])
  })

  it('passes the workspace, path and documentId the cleanup needs to find its files', async () => {
    const deps = makeDeps()
    const { events, teardown } = makeRecordingTeardown()
    deps.documentTeardown = teardown
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'nested/doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })

    await wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: created.documentId })

    expect(events).toEqual([`begin:ws-1:nested/doc-a:${created.documentId}`, 'finalize'])
  })

  // A refused delete must not destroy anything. The index refuses while
  // documents sit below this one, and that refusal happens AFTER begin.
  it('does not finalize when the index refuses the delete', async () => {
    const deps = makeDeps()
    const { events, teardown } = makeRecordingTeardown()
    deps.documentTeardown = teardown
    const parent = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent',
      kind: 'spatial',
      createWorkspace: true,
    })
    await wbDocumentCreate(deps, { workspaceId: 'ws-1', path: 'parent/child', kind: 'spatial' })

    await expect(
      wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: parent.documentId }),
    ).rejects.toThrow(DocumentHasDescendantsError)

    expect(events).not.toContain('finalize')
  })

  it('never begins teardown for a documentId that does not exist', async () => {
    const deps = makeDeps()
    const { events, teardown } = makeRecordingTeardown()
    deps.documentTeardown = teardown

    await expect(
      wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ).rejects.toThrow()

    expect(events).toEqual([])
  })
})
