import type { DocumentIndex } from '@kamiazya/whiteboard-canvas-ports'
import {
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathTakenError,
} from '@kamiazya/whiteboard-canvas-ports'
import { expect, it } from 'vitest'

/**
 * The `DocumentIndex` guarantees that a TypeScript signature cannot carry,
 * expressed as tests every implementation has to pass. The port's doc
 * comments state them; this is where they stop being prose.
 *
 * Taken as a factory rather than written inline against one implementation
 * so the second one — the browser store, when `apps/web` grows a daemon-free
 * document index — inherits the same bar by calling it. It lives beside the
 * only current implementation instead of in `canvas-ports` because that
 * package publishes no test-utils entry point, and adding one before a second
 * caller exists would be plumbing for nobody.
 */
export function describeDocumentIndexConformance(
  makeIndex: () => Promise<{ index: DocumentIndex; dispose: () => Promise<void> }>,
): void {
  const WS = 'ws-conformance'

  async function withIndex(body: (index: DocumentIndex) => Promise<void>): Promise<void> {
    const { index, dispose } = await makeIndex()
    try {
      await body(index)
    } finally {
      await dispose()
    }
  }

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
      expect(moved?.canvasId).toBe(child.canvasId)
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
      // implementation that never checks pass this test.
      await expect(index.moveDocument({ workspaceId: WS, from: 'a', to: 'c' })).rejects.toThrow(
        DocumentPathTakenError,
      )

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
      expect((await index.resolveDocument({ workspaceId: WS, path: 'a/b' }))?.canvasId).toBe(
        grandchild.canvasId,
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
      expect(theirs.canvasId).not.toBe(mine.canvasId)

      expect((await index.resolveDocument({ workspaceId: WS, path: 'p' }))?.kind).toBe('spatial')
      expect(await index.listDocuments({ workspaceId: WS })).toHaveLength(1)

      await index.deleteDocument({ workspaceId: WS, path: 'p' })
      expect(await index.resolveDocument({ workspaceId: 'ws-other', path: 'p' })).not.toBeNull()
    })
  })
}
