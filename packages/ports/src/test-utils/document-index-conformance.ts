import { describe, expect, it } from 'vitest'
import type { DocumentIndex, WorkspaceEntry } from '../index.js'
import {
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathTakenError,
  WorkspaceNotFoundError,
  workspaceEntrySchema,
} from '../index.js'

/**
 * The `DocumentIndex` guarantees that a TypeScript signature cannot carry,
 * expressed as tests every implementation has to pass. The port's doc
 * comments state them; this is where they stop being prose.
 *
 * Taken as a factory rather than written inline against one implementation
 * so the second one — the browser store, when `apps/web` grows a daemon-free
 * document index — inherits the same bar by calling it. It lives beside the
 * port itself, so an implementation in any package inherits the same bar by
 * calling it.
 */
type SeedWorkspace = (entry: WorkspaceEntry) => Promise<void>

export function describeDocumentIndexConformance(
  makeIndex: () => Promise<{
    index: DocumentIndex
    dispose: () => Promise<void>
    /**
     * Puts a workspace into the REGISTRY the index resolves against, carrying
     * whatever identity the entry names.
     *
     * Required, not optional, and separate from `createWorkspace` for a
     * structural reason: `createWorkspace` MAY ignore `segment` — the port
     * says so — because for a tree-backed index the registry is a different
     * collaborator, and only the composition root that owns registry rows can
     * write one. So an implementation whose `createWorkspace` cannot persist
     * a segment is not thereby excused from RESOLVING one, and this seam is
     * how each wires the suite to whatever actually holds its rows.
     *
     * An optional seam would be skipped silently by exactly the
     * implementation that needed checking.
     */
    seedWorkspace: (entry: WorkspaceEntry) => Promise<void>
  }>,
): void {
  const WS = 'ws-conformance'
  // A well-formed id the index never assigned.
  const ABSENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

  async function withIndex(
    body: (index: DocumentIndex, seedWorkspace: SeedWorkspace) => Promise<void>,
  ): Promise<void> {
    const { index, dispose, seedWorkspace } = await makeIndex()
    try {
      // Workspaces are explicit now, so the shared fixture makes the two the
      // cases below use rather than each test repeating it.
      await index.createWorkspace({ workspaceId: WS })
      await index.createWorkspace({ workspaceId: 'ws-other' })
      await body(index, seedWorkspace)
    } finally {
      await dispose()
    }
  }

  it('carries a name when given one, and reports none as absent rather than null', async () => {
    await withIndex(async (index) => {
      const named = await index.createDocument({
        workspaceId: WS,
        path: 'named',
        kind: 'spatial',
        name: 'Quarterly plan',
      })
      expect(named.name).toBe('Quarterly plan')
      expect((await index.resolveDocument({ workspaceId: WS, path: 'named' }))?.name).toBe(
        'Quarterly plan',
      )

      const anonymous = await index.createDocument({
        workspaceId: WS,
        path: 'anonymous',
        kind: 'spatial',
      })
      expect('name' in anonymous).toBe(false)
      const readBack = await index.resolveDocument({ workspaceId: WS, path: 'anonymous' })
      expect(readBack).not.toBeNull()
      expect('name' in (readBack as object)).toBe(false)
    })
  })

  it('refuses to LIST a workspace that does not exist, rather than reporting it empty', async () => {
    await withIndex(async (index) => {
      // An empty answer would make a typo'd workspaceId indistinguishable
      // from a workspace that genuinely holds nothing.
      await expect(index.listDocuments({ workspaceId: 'never-created' })).rejects.toThrow(
        WorkspaceNotFoundError,
      )
      await expect(index.listDocuments({ workspaceId: WS })).resolves.toEqual([])
    })
  })

  it('refuses to create a document in a workspace that does not exist', async () => {
    await withIndex(async (index) => {
      // A typo'd or hallucinated workspaceId must fail loudly rather than
      // quietly bringing a workspace into being and writing into it.
      await expect(
        index.createDocument({ workspaceId: 'never-created', path: 'plan', kind: 'spatial' }),
      ).rejects.toThrow(WorkspaceNotFoundError)
      // A second attempt, because refusing is not the same as not creating:
      // an implementation can materialize the workspace as a side effect and
      // still throw, and then only the SECOND call reveals it by succeeding.
      await expect(
        index.createDocument({ workspaceId: 'never-created', path: 'plan-2', kind: 'spatial' }),
      ).rejects.toThrow(WorkspaceNotFoundError)
    })
  })

  it('creates a workspace idempotently, and only then accepts documents', async () => {
    await withIndex(async (index) => {
      await index.createWorkspace({ workspaceId: 'fresh' })
      await index.createWorkspace({ workspaceId: 'fresh' })
      await expect(
        index.createDocument({ workspaceId: 'fresh', path: 'plan', kind: 'spatial' }),
      ).resolves.toMatchObject({ path: 'plan' })
    })
  })

  it('resolves a document by the id it was assigned, scoped to its workspace', async () => {
    await withIndex(async (index) => {
      const created = await index.createDocument({
        workspaceId: WS,
        path: 'plan/sub',
        kind: 'markdown',
      })

      expect(
        await index.resolveDocumentById({ workspaceId: WS, documentId: created.documentId }),
      ).toEqual(created)
      // The id alone is not the address: another workspace must not see it.
      await index.createWorkspace({ workspaceId: 'ws-other' })
      expect(
        await index.resolveDocumentById({
          workspaceId: 'ws-other',
          documentId: created.documentId,
        }),
      ).toBeNull()
    })
  })

  it('creates a document a later resolve finds, and reports absent as null', async () => {
    await withIndex(async (index) => {
      const created = await index.createDocument({ workspaceId: WS, path: 'plan', kind: 'spatial' })
      expect(created.path).toBe('plan')
      expect(created.kind).toBe('spatial')

      expect(await index.resolveDocument({ workspaceId: WS, path: 'plan' })).toEqual(created)
      expect(await index.resolveDocument({ workspaceId: WS, path: 'absent' })).toBeNull()
    })
  })

  it('refuses to create over a path that is taken', async () => {
    await withIndex(async (index) => {
      await index.createDocument({ workspaceId: WS, path: 'plan', kind: 'spatial' })
      await expect(
        index.createDocument({ workspaceId: WS, path: 'plan', kind: 'markdown' }),
      ).rejects.toThrow(DocumentPathTakenError)
      // The loser must not have changed what is there.
      expect((await index.resolveDocument({ workspaceId: WS, path: 'plan' }))?.kind).toBe('spatial')
    })
  })

  it('lets exactly one of many concurrent creates of one path win', async () => {
    await withIndex(async (index) => {
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          index.createDocument({ workspaceId: WS, path: 'contended', kind: 'spatial' }),
        ),
      )
      // Serialized per workspace: a check-then-write implementation can let two
      // callers past the check, and the losers then fail some other way (a raw
      // constraint violation) or not at all (a duplicate row).
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1)
      expect(await index.listDocuments({ workspaceId: WS })).toHaveLength(1)
    })
  })

  it('lists ordered segment-wise, segments by code point, a path before what it prefixes', async () => {
    await withIndex(async (index) => {
      // Insertion order deliberately unrelated to the expected order.
      for (const path of ['a-b', 'a/b', 'a', 'a/2', 'a/10']) {
        await index.createDocument({ workspaceId: WS, path, kind: 'spatial' })
      }

      const paths = (await index.listDocuments({ workspaceId: WS })).map((entry) => entry.path)
      // `a-b` last because segment-wise compares `a` against `a-b` and the
      // shorter sorts first; whole-string comparison would put it between `a`
      // and `a/b` (`-` is 0x2D, `/` is 0x2F) and split the subtree. `a/10`
      // before `a/2` because segments compare by code point, not numerically.
      expect(paths).toEqual(['a', 'a/10', 'a/2', 'a/b', 'a-b'])
    })
  })

  it('moves a document and every descendant with it', async () => {
    await withIndex(async (index) => {
      await index.createDocument({ workspaceId: WS, path: 'a', kind: 'spatial' })
      const child = await index.createDocument({ workspaceId: WS, path: 'a/d', kind: 'markdown' })

      await index.moveDocument({ workspaceId: WS, from: 'a', to: 'c' })

      expect(await index.resolveDocument({ workspaceId: WS, path: 'a' })).toBeNull()
      expect(await index.resolveDocument({ workspaceId: WS, path: 'a/d' })).toBeNull()
      const moved = await index.resolveDocument({ workspaceId: WS, path: 'c/d' })
      // The same document, relocated — not a new one.
      expect(moved?.documentId).toBe(child.documentId)
      expect(moved?.kind).toBe('markdown')
    })
  })

  it('refuses a move that collides at a descendant, and changes nothing', async () => {
    await withIndex(async (index) => {
      for (const path of ['a', 'a/d', 'c/d']) {
        await index.createDocument({ workspaceId: WS, path, kind: 'spatial' })
      }
      // `c` itself is free, so a check of the destination alone would allow it.
      expect(await index.resolveDocument({ workspaceId: WS, path: 'c' })).toBeNull()

      // The named error, not merely "something threw": a backing store with a
      // unique index throws on the write anyway, which would let an
      // implementation that never checks pass this test. And the error names
      // the path that actually collided (`c/d`), not the free destination the
      // caller asked for — a message naming `c` sends the caller to retry a
      // rename that was never the problem.
      const rejection = await index
        .moveDocument({ workspaceId: WS, from: 'a', to: 'c' })
        .then(() => null)
        .catch((err: unknown) => err)
      expect(rejection).toBeInstanceOf(DocumentPathTakenError)
      expect((rejection as DocumentPathTakenError).path).toBe('c/d')

      // Rejected whole: no half-move left behind.
      expect(await index.resolveDocument({ workspaceId: WS, path: 'a' })).not.toBeNull()
      expect(await index.resolveDocument({ workspaceId: WS, path: 'a/d' })).not.toBeNull()
      expect(await index.resolveDocument({ workspaceId: WS, path: 'c' })).toBeNull()
    })
  })

  it('allows a subtree to move up into a path it is itself vacating', async () => {
    await withIndex(async (index) => {
      // The one arrangement where a produced path equals a vacated one:
      // `a/b` moving to `a` produces `a` and `a/b`, and `a/b` is exactly what
      // the move is emptying. Treating it as occupied would refuse a move
      // that is perfectly well defined.
      // Deepest first, deliberately. A store that rewrites rows in whatever
      // order its query returned will then try `a/b/b` -> `a/b` while the
      // original `a/b` is still there, and collide on a move the contract
      // says must succeed. Creating the shallow one first hides that behind
      // insertion order.
      const grandchild = await index.createDocument({
        workspaceId: WS,
        path: 'a/b/b',
        kind: 'markdown',
      })
      await index.createDocument({ workspaceId: WS, path: 'a/b', kind: 'spatial' })

      await index.moveDocument({ workspaceId: WS, from: 'a/b', to: 'a' })

      expect((await index.listDocuments({ workspaceId: WS })).map((e) => e.path)).toEqual([
        'a',
        'a/b',
      ])
      expect((await index.resolveDocument({ workspaceId: WS, path: 'a/b' }))?.documentId).toBe(
        grandchild.documentId,
      )
    })
  })

  it('orders a self-vacating move by depth, not by path order', async () => {
    await withIndex(async (index) => {
      // The contended pair here are NOT ancestor and descendant of each
      // other: `a/b/x` and `a/b/b/x` branch below `a/b`. Moving `a/b` to `a`
      // sends the second onto the path the first is vacating, so the first
      // has to write before the second — and segment-wise path order puts
      // them the other way round, because `b` sorts before `x`. Only depth
      // separates them.
      await index.createDocument({ workspaceId: WS, path: 'a/b/x', kind: 'spatial' })
      await index.createDocument({ workspaceId: WS, path: 'a/b/b/x', kind: 'markdown' })

      await index.moveDocument({ workspaceId: WS, from: 'a/b', to: 'a' })

      expect((await index.listDocuments({ workspaceId: WS })).map((e) => e.path)).toEqual([
        'a/b/x',
        'a/x',
      ])
    })
  })

  it('refuses a move into the moving subtree', async () => {
    await withIndex(async (index) => {
      await index.createDocument({ workspaceId: WS, path: 'a', kind: 'spatial' })
      await index.createDocument({ workspaceId: WS, path: 'a/x', kind: 'spatial' })

      await expect(index.moveDocument({ workspaceId: WS, from: 'a', to: 'a/b' })).rejects.toThrow(
        DocumentMoveIntoSelfError,
      )

      expect(await index.resolveDocument({ workspaceId: WS, path: 'a' })).not.toBeNull()
      expect(await index.resolveDocument({ workspaceId: WS, path: 'a/x' })).not.toBeNull()
    })
  })

  it('refuses to delete a document that still has descendants', async () => {
    await withIndex(async (index) => {
      await index.createDocument({ workspaceId: WS, path: 'a', kind: 'spatial' })
      await index.createDocument({ workspaceId: WS, path: 'a/child', kind: 'spatial' })

      await expect(index.deleteDocument({ workspaceId: WS, path: 'a' })).rejects.toThrow(
        DocumentHasDescendantsError,
      )
      expect(await index.resolveDocument({ workspaceId: WS, path: 'a' })).not.toBeNull()

      // Naming the child first is the way through.
      await index.deleteDocument({ workspaceId: WS, path: 'a/child' })
      await index.deleteDocument({ workspaceId: WS, path: 'a' })
      expect(await index.listDocuments({ workspaceId: WS })).toEqual([])
    })
  })

  it('refuses to move a path that names nothing', async () => {
    await withIndex(async (index) => {
      await expect(
        index.moveDocument({ workspaceId: WS, from: 'absent', to: 'somewhere' }),
      ).rejects.toThrow(DocumentNotFoundError)
    })
  })

  it('treats deleting an absent path as done', async () => {
    await withIndex(async (index) => {
      await expect(
        index.deleteDocument({ workspaceId: WS, path: 'never-existed' }),
      ).resolves.toBeUndefined()
    })
  })

  it('scopes every operation to its workspace', async () => {
    await withIndex(async (index) => {
      const mine = await index.createDocument({ workspaceId: WS, path: 'p', kind: 'spatial' })
      const theirs = await index.createDocument({
        workspaceId: 'ws-other',
        path: 'p',
        kind: 'markdown',
      })
      expect(theirs.documentId).not.toBe(mine.documentId)

      expect((await index.resolveDocument({ workspaceId: WS, path: 'p' }))?.kind).toBe('spatial')
      expect(await index.listDocuments({ workspaceId: WS })).toHaveLength(1)

      await index.deleteDocument({ workspaceId: WS, path: 'p' })
      expect(await index.resolveDocument({ workspaceId: 'ws-other', path: 'p' })).not.toBeNull()
    })
  })

  describe('setDocumentName', () => {
    it('renames a document without moving it', async () => {
      await withIndex(async (index) => {
        const { documentId } = await index.createDocument({
          workspaceId: WS,
          path: 'a/b',
          kind: 'markdown',
          name: 'Old',
        })

        await index.setDocumentName({ workspaceId: WS, documentId, name: 'New' })

        const entry = await index.resolveDocumentById({ workspaceId: WS, documentId })
        expect(entry?.name).toBe('New')
        // The name is not the placement: renaming must not relocate it.
        expect(entry?.path).toBe('a/b')
      })
    })

    it('clears the name when given none', async () => {
      await withIndex(async (index) => {
        const { documentId } = await index.createDocument({
          workspaceId: WS,
          path: 'p',
          kind: 'spatial',
          name: 'Named',
        })

        await index.setDocumentName({ workspaceId: WS, documentId })

        expect(
          (await index.resolveDocumentById({ workspaceId: WS, documentId }))?.name,
        ).toBeUndefined()
      })
    })

    it('fails for a document that is not there', async () => {
      await withIndex(async (index) => {
        await expect(
          index.setDocumentName({ workspaceId: WS, documentId: ABSENT_ID, name: 'x' }),
        ).rejects.toThrow(DocumentNotFoundError)
      })
    })

    it('will not rename across workspaces', async () => {
      await withIndex(async (index) => {
        const { documentId } = await index.createDocument({
          workspaceId: WS,
          path: 'p',
          kind: 'spatial',
        })

        await expect(
          index.setDocumentName({ workspaceId: 'ws-other', documentId, name: 'x' }),
        ).rejects.toThrow(DocumentNotFoundError)
      })
    })
  })

  describe('listWorkspaces', () => {
    // The shared fixture creates two, so a listing that reported only the one
    // a test had just touched would pass a weaker assertion.
    it('reports every workspace the index holds, whether or not it has documents', async () => {
      await withIndex(async (index) => {
        await index.createDocument({ workspaceId: WS, path: 'p', kind: 'spatial' })

        const ids = (await index.listWorkspaces()).map((w) => w.workspaceId).sort()

        expect(ids).toContain(WS)
        // `ws-other` holds nothing. A workspace is a real, addressable place
        // before anything is put in it — a listing that hid the empty ones
        // would make a freshly created workspace look like it failed.
        expect(ids).toContain('ws-other')
      })
    })

    // Deliberately NOT `toEqual([])`. An implementation may legitimately hold
    // a workspace of its own from the moment its store exists: apps/web's
    // IndexedDB index writes `local` during its upgrade, because that is the
    // one the browser UI opens. Pinning emptiness here forbade that, and the
    // browser conformance run said so.
    //
    // What the contract does require is an ANSWER rather than a throw. Unlike
    // `listDocuments`, there is no id here that could have been a typo, so
    // "none" is a result and not an ambiguity — and a caller listing
    // workspaces before any document exists must not meet an error.
    it('answers rather than throwing on an index with no documents in it', async () => {
      const { index, dispose } = await makeIndex()
      try {
        const workspaces = await index.listWorkspaces()
        expect(Array.isArray(workspaces)).toBe(true)
        expect(workspaces.every((w) => typeof w.workspaceId === 'string')).toBe(true)
      } finally {
        await dispose()
      }
    })

    // ADR-0019's identity layers ride along on createWorkspace/listWorkspaces
    // without every implementation SERVING them: this base case only proves
    // segment/displayName do not break an implementation that accepts and
    // ignores them (apps/web's browser registry, the in-memory double), so
    // it deliberately does NOT assert echo-back. mcp-server's daemon DOES
    // persist and serve these fields now — that echo is pinned by its own
    // tests (document-store.test.ts), not by this shared suite, because
    // adding the assertion here would fail the implementations that still
    // legitimately ignore them.
    it('accepts a createWorkspace carrying segment and displayName, currently ignored', async () => {
      await withIndex(async (index) => {
        await index.createWorkspace({
          workspaceId: 'ws-identity',
          segment: 'team-notes',
          displayName: 'Team notes',
        })
        // Idempotent, same as the bare-id case: re-creating is not an error.
        await index.createWorkspace({
          workspaceId: 'ws-identity',
          segment: 'team-notes',
          displayName: 'Team notes',
        })

        const ids = (await index.listWorkspaces()).map((w) => w.workspaceId)
        expect(ids).toContain('ws-identity')
      })
    })

    it('every listWorkspaces row parses against workspaceEntrySchema', async () => {
      await withIndex(async (index) => {
        const rows = await index.listWorkspaces()
        // A guard that never reaches its subject passes vacuously — the
        // shared fixture creates two workspaces, so this cannot be empty.
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) {
          expect(workspaceEntrySchema.safeParse(row).success).toBe(true)
        }
      })
    })

    describe('resolveWorkspace', () => {
      /**
       * `createWorkspace` IS the seam: the port already accepts a segment, so
       * an implementation that cannot resolve one is an implementation that
       * did not store it, and both halves are worth failing on here rather
       * than in whichever surface first tries to address by segment.
       */
      async function withSegmented(body: (index: DocumentIndex) => Promise<void>): Promise<void> {
        await withIndex(async (index, seedWorkspace) => {
          await seedWorkspace({ workspaceId: 'ws-segmented', segment: 'design' })
          // Assert the subject is PRESENT before asserting anything about it:
          // an implementation that silently drops `segment` would otherwise
          // make every case below pass by resolving nothing but ids.
          const stored = (await index.listWorkspaces()).find(
            (w) => w.workspaceId === 'ws-segmented',
          )
          expect(stored?.segment).toBe('design')
          await body(index, seedWorkspace)
        })
      }

      it('resolves a workspace by its segment', async () => {
        await withSegmented(async (index) => {
          expect((await index.resolveWorkspace('design'))?.workspaceId).toBe('ws-segmented')
        })
      })

      it('resolves a segment-bearing workspace by its id too', async () => {
        await withSegmented(async (index) => {
          expect((await index.resolveWorkspace('ws-segmented'))?.workspaceId).toBe('ws-segmented')
        })
      })

      it('resolves a workspace that has no segment by its id', async () => {
        await withIndex(async (index) => {
          expect((await index.resolveWorkspace(WS))?.workspaceId).toBe(WS)
        })
      })

      it("prefers a segment over another workspace's id", async () => {
        await withIndex(async (index, seedWorkspace) => {
          // `ws-other` exists as an id in the shared fixture; giving a
          // DIFFERENT workspace that same string as its segment is the one
          // collision the resolution order has to decide.
          await seedWorkspace({ workspaceId: 'ws-shadowing', segment: 'ws-other' })
          expect((await index.resolveWorkspace('ws-other'))?.workspaceId).toBe('ws-shadowing')
          // The shadowed workspace stays reachable as itself.
          expect((await index.resolveWorkspace('ws-shadowing'))?.workspaceId).toBe('ws-shadowing')
        })
      })

      it('answers null for a handle nothing answers to', async () => {
        await withIndex(async (index) => {
          expect(await index.resolveWorkspace('no-such-workspace')).toBeNull()
        })
      })
    })
  })
}
