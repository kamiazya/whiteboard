import { documentIdSchema } from '@kamiazya/whiteboard-model'
import { DocumentHasDescendantsError, DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { ignoredDocumentWrites } from '../test-utils/ignored-document-writes.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { WorkspaceDocumentNotFoundError, WorkspaceNotFoundError } from './document-crud.errors.js'
import {
  wbDocumentCreate,
  wbDocumentDelete,
  wbDocumentList,
  wbDocumentResolve,
} from './document-crud.js'

const WS = 'ws-1'

/**
 * The workspace exists because this fixture says so. It used to appear as a
 * side effect of the first `createWorkspace: true` — which is ADR-0019's MINT
 * boundary, and now keys the workspace by a fresh ULID, leaving the `ws-1`
 * every case below addresses naming nothing.
 *
 * The three cases that are ABOUT creating a workspace keep saying so
 * explicitly; everything else just needs one to exist.
 */
async function makeDeps(): Promise<ServerDeps> {
  const deps: ServerDeps = {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
    documentTeardown: inMemoryDocumentTeardown(),
    documentWritten: ignoredDocumentWrites(),
  }
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  return deps
}

describe('wbDocumentCreate', () => {
  // `DocumentEntry.name` is `z.string().min(1).optional()`, and its own
  // comment says why: absent is the meaningful "no name" state, where a
  // reader falls back to the path segment. An empty string is neither — a
  // name that reads as nothing, which the port says cannot exist.
  //
  // Normalised rather than rejected, because ADR-0006 point 3 is the older
  // rule and outranks tidiness here: naming must never gate creation. A
  // caller that sends a blank name gets a document, not an error.
  it('treats a blank name as no name rather than storing one the port forbids', async () => {
    const deps = await makeDeps()
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'blank',
      kind: 'spatial',
      name: '   ',
    })

    const entry = await deps.documentIndex.resolveDocumentById({
      workspaceId: 'ws-1',
      documentId: created.documentId,
    })
    expect(entry?.name).toBeUndefined()
  })

  it('creates a document and returns documentId + path', async () => {
    const deps = await makeDeps()
    const result = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
    })
    expect(result.path).toBe('doc-a')
    expect(() => documentIdSchema.parse(result.documentId)).not.toThrow()
  })

  it('nests by path, with no parent id involved', async () => {
    const deps = await makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent',
      kind: 'spatial',
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
    const deps = await makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
    })
    await expect(
      wbDocumentCreate(deps, { workspaceId: 'ws-1', path: 'doc-a', kind: 'markdown' }),
    ).rejects.toThrow(DocumentPathTakenError)
  })

  it('throws WorkspaceNotFoundError for an unknown workspaceId, and list agrees', async () => {
    const deps = await makeDeps()
    await expect(
      wbDocumentCreate(deps, { workspaceId: 'nope', path: 'doc-a', kind: 'spatial' }),
    ).rejects.toThrow(WorkspaceNotFoundError)
    await expect(wbDocumentList(deps, { workspaceId: 'nope' })).rejects.toThrow(
      WorkspaceNotFoundError,
    )
  })

  it('materializes the workspace when createWorkspace: true is passed', async () => {
    const deps = await makeDeps()
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-new',
      path: 'doc-a',
      kind: 'spatial',
      createWorkspace: true,
    })
    // Listed by the id the create REPORTS, not by the handle that was sent:
    // creating is ADR-0019's mint boundary, so `ws-new` is now the new
    // workspace's segment rather than its id. That the handle still resolves
    // is the mint suite's subject; this one is only about the workspace
    // coming into existence with the document in it.
    const { documents } = await wbDocumentList(deps, { workspaceId: created.workspaceId })
    expect(documents).toHaveLength(1)
  })

  it('succeeds without the flag once the workspace exists', async () => {
    const deps = await makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'first',
      kind: 'spatial',
    })
    const second = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'second',
      kind: 'spatial',
    })
    expect(second.path).toBe('second')
  })
})

describe('wbDocumentList shadowed threading', () => {
  it('carries a shadowed marker through — the collision signal must survive the tool boundary', async () => {
    const deps = await makeDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    ;(deps.documentIndex as InMemoryDocumentIndex).seed({
      workspaceId: 'ws-1',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      path: 'a',
      kind: 'spatial',
      shadowed: true,
    })

    const out = await wbDocumentList(deps, { workspaceId: 'ws-1' })

    expect(out.documents).toEqual([
      {
        documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        path: 'a',
        kind: 'spatial',
        shadowed: true,
      },
    ])
  })
})

describe('wbDocumentResolve', () => {
  // `documentDetailSchema` is shared with the list, so resolve must EMIT what
  // that schema declares. Omitting these left the schema saying more than the
  // runtime did.
  it('carries kind and updatedAt through, like the list does', async () => {
    const deps = await makeDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    ;(deps.documentIndex as InMemoryDocumentIndex).seed({
      workspaceId: 'ws-1',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      path: 'a',
      kind: 'markdown',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })

    const out = await wbDocumentResolve(deps, {
      workspaceId: 'ws-1',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })

    expect(out).toEqual({
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      path: 'a',
      kind: 'markdown',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })
  })

  it('returns the document with its path', async () => {
    const deps = await makeDeps()
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent/child',
      kind: 'spatial',
    })
    const got = await wbDocumentResolve(deps, {
      workspaceId: 'ws-1',
      documentId: created.documentId,
    })
    // `kind` is reported now that resolve emits what its schema declares. The
    // in-memory index records no timestamp, which is why `updatedAt` is absent
    // here and present in the case below that seeds one.
    expect(got).toEqual({
      documentId: created.documentId,
      path: 'parent/child',
      kind: 'spatial',
    })
  })

  it('throws WorkspaceDocumentNotFoundError for a documentId that does not exist', async () => {
    const deps = await makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
    })
    await expect(
      wbDocumentResolve(deps, { workspaceId: 'ws-1', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })

  it('does not resolve a document from another workspace', async () => {
    const deps = await makeDeps()
    // A SECOND workspace, which makeDeps does not provide.
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-2' })
    const mine = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'doc-a',
      kind: 'spatial',
    })
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-2',
      path: 'doc-a',
      kind: 'spatial',
    })
    // An id is a handle within a workspace, not a capability that reaches
    // across them.
    await expect(
      wbDocumentResolve(deps, { workspaceId: 'ws-2', documentId: mine.documentId }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })
})

describe('wbDocumentList', () => {
  // The HTTP list surface reports both, and it used to reach the store
  // directly because this operation dropped them — an adapter cannot report
  // what the operation refuses to carry. `updatedAt` is OPTIONAL on
  // `DocumentEntry` because the browser's index genuinely does not own it
  // (apps/web reads timestamps from a separate store), so this asserts the
  // pass-through, not that every index supplies one.
  it('carries kind and updatedAt through rather than dropping them', async () => {
    const deps = await makeDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    ;(deps.documentIndex as InMemoryDocumentIndex).seed({
      workspaceId: 'ws-1',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      path: 'a',
      kind: 'markdown',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })

    const out = await wbDocumentList(deps, { workspaceId: 'ws-1' })

    expect(out.documents).toEqual([
      {
        documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        path: 'a',
        kind: 'markdown',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ])
  })

  it('throws WorkspaceNotFoundError for a workspace that was never created', async () => {
    const deps = await makeDeps()
    await expect(wbDocumentList(deps, { workspaceId: 'ghost' })).rejects.toThrow(
      WorkspaceNotFoundError,
    )
  })

  it('returns an empty list for a workspace that exists and holds nothing', async () => {
    const deps = await makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'only',
      kind: 'spatial',
    })
    await wbDocumentDelete(deps, {
      workspaceId: 'ws-1',
      documentId: (await wbDocumentList(deps, { workspaceId: 'ws-1' })).documents[0]!.documentId,
    })
    expect((await wbDocumentList(deps, { workspaceId: 'ws-1' })).documents).toEqual([])
  })

  it('returns every document, ordered so each subtree stays together', async () => {
    const deps = await makeDeps()
    for (const path of ['b-side', 'a', 'a/deep', 'a-sibling']) {
      await wbDocumentCreate(deps, {
        workspaceId: 'ws-1',
        path,
        kind: 'spatial',
      })
    }
    const { documents } = await wbDocumentList(deps, { workspaceId: 'ws-1' })
    // `a-sibling` after `a/deep`, because comparing whole strings would put
    // it between `a` and its own child and split the subtree apart.
    expect(documents.map((c) => c.path)).toEqual(['a', 'a/deep', 'a-sibling', 'b-side'])
  })

  it('excludes a deleted document', async () => {
    const deps = await makeDeps()
    const keep = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'keep',
      kind: 'spatial',
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
    const deps = await makeDeps()
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
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
    const deps = await makeDeps()
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
    })
    const docRef = {
      kind: 'document',
      workspaceId: 'ws-1',
      documentId: created.documentId,
    } as const
    expect(await deps.documentStore.loadSnapshot({ docRef })).not.toBeNull()

    await wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: created.documentId })

    expect(await deps.documentStore.loadSnapshot({ docRef })).toBeNull()
  })

  it('throws WorkspaceDocumentNotFoundError when deleting a documentId that does not exist', async () => {
    const deps = await makeDeps()
    await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
    })
    await expect(
      wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })

  it('refuses to delete a document that still has documents below it', async () => {
    const deps = await makeDeps()
    const parent = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent',
      kind: 'spatial',
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
      ...(name === undefined ? {} : { name }),
    })
  }

  it('creation accepts a name and the listing returns it', async () => {
    const deps = await makeDeps()
    await createNamed(deps, 'Quarterly plan')
    const { documents } = await wbDocumentList(deps, { workspaceId: 'ws-1' })
    expect(documents[0]?.name).toBe('Quarterly plan')
  })

  it('omits the name entirely when none was given, rather than echoing the path', async () => {
    const deps = await makeDeps()
    await createNamed(deps)
    const { documents } = await wbDocumentList(deps, { workspaceId: 'ws-1' })
    expect(documents[0]).toBeDefined()
    expect('name' in (documents[0] as object)).toBe(false)
  })

  it('a name is free text, not a second path', async () => {
    const deps = await makeDeps()
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
    const deps = await makeDeps()
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
        async around<T>(
          input: { workspaceId: string; documentId: string; path: string },
          deleteDocument: () => Promise<T>,
        ) {
          events.push(`enter:${input.workspaceId}:${input.path}:${input.documentId}`)
          const result = await deleteDocument()
          events.push('cleanup')
          return result
        },
      },
    }
  }

  it('enters teardown while the document still exists and cleans up after it is gone', async () => {
    const deps = await makeDeps()
    const { events, teardown } = makeRecordingTeardown()
    deps.documentTeardown = teardown
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doc-a',
      kind: 'spatial',
    })
    const docRef = {
      kind: 'document',
      workspaceId: 'ws-1',
      documentId: created.documentId,
    } as const

    // Recorded from inside the seam, not asserted afterwards: whether the
    // row was still there ON ENTRY is the whole point — a version's
    // thumbnail is filed under a version id that cascades away with it.
    const index = deps.documentIndex
    const store = deps.documentStore
    deps.documentTeardown = {
      async around(input, deleteDocument) {
        const stillIndexed = await index.resolveDocumentById({
          workspaceId: input.workspaceId,
          documentId: input.documentId,
        })
        events.push(`enter:indexed=${stillIndexed !== null}`)
        const result = await deleteDocument()
        events.push(
          `cleanup:indexed=${
            (await index.resolveDocumentById({
              workspaceId: input.workspaceId,
              documentId: input.documentId,
            })) !== null
          }`,
        )
        events.push(`cleanup:snapshot=${(await store.loadSnapshot({ docRef })) !== null}`)
        return result
      },
    }

    await wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: created.documentId })

    expect(events).toEqual([
      'enter:indexed=true',
      'cleanup:indexed=false',
      'cleanup:snapshot=false',
    ])
  })

  it('passes the workspace, path and documentId the cleanup needs to find its files', async () => {
    const deps = await makeDeps()
    const { events, teardown } = makeRecordingTeardown()
    deps.documentTeardown = teardown
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'nested/doc-a',
      kind: 'spatial',
    })

    await wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: created.documentId })

    expect(events).toEqual([`enter:ws-1:nested/doc-a:${created.documentId}`, 'cleanup'])
  })

  // A refused delete must not destroy anything. The index refuses while
  // documents sit below this one, and that refusal happens INSIDE the
  // bracket — it throws past the cleanup rather than being caught by it.
  it('does not clean up when the index refuses the delete', async () => {
    const deps = await makeDeps()
    const { events, teardown } = makeRecordingTeardown()
    deps.documentTeardown = teardown
    const parent = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'parent',
      kind: 'spatial',
    })
    await wbDocumentCreate(deps, { workspaceId: 'ws-1', path: 'parent/child', kind: 'spatial' })

    await expect(
      wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: parent.documentId }),
    ).rejects.toThrow(DocumentHasDescendantsError)

    expect(events).not.toContain('cleanup')
  })

  it('never enters teardown for a documentId that does not exist', async () => {
    const deps = await makeDeps()
    const { events, teardown } = makeRecordingTeardown()
    deps.documentTeardown = teardown

    await expect(
      wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ).rejects.toThrow()

    expect(events).toEqual([])
  })
})
