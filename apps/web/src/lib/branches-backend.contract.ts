import { BranchesUnsupportedError } from './branches-backend.js'
import { expect, it } from 'vitest'
import type { BranchesBackend } from './branches-backend.js'

/**
 * The behavioural contract a `BranchesBackend` with branches must satisfy,
 * written once and run against each keeper that has them.
 *
 * Today that is the daemon alone, so this file pins what a caller of the seam
 * is entitled to rely on before a second keeper exists — the shape the
 * browser keeper will have to answer when it grows branches, rather than the
 * shape it happens to grow. Same reasoning as `versions-backend.contract.ts`:
 * a behaviour one keeper gets wrong is only caught if somebody thought to
 * write that case in that keeper's file, and a feature the other keeper never
 * gets is an absent test rather than a failing one. This contract is the
 * first half; `keeper-parity.test.ts` is the ledger for the second.
 *
 * Cases are keeper-independent — no assertion about which route is called or
 * which row is written. `main` is the one name every keeper has to know: it
 * is the default variation (ADR-0022), the one with no name to put in an
 * address, and the head a document has before anybody makes a branch.
 */
export interface BranchesBackendHarness {
  backend: BranchesBackend
  workspaceId: string
  path: string
  cleanup(): Promise<void>
}

export function branchesBackendContract(
  create: () => BranchesBackendHarness | Promise<BranchesBackendHarness>,
): void {
  it('declares that it has branches', async () => {
    const h = await create()
    try {
      expect(h.backend.hasBranches).toBe(true)
    } finally {
      await h.cleanup()
    }
  })

  it('answers main as the resting head before any branch is made', async () => {
    const h = await create()
    try {
      const state = await h.backend.list(h.workspaceId, h.path)
      expect(state.head).toBe('main')
      expect(state.branches.map((b) => b.name)).toContain('main')
    } finally {
      await h.cleanup()
    }
  })

  it('lists a created branch with the colour it was given, and leaves HEAD where it was', async () => {
    const h = await create()
    try {
      const made = await h.backend.create(h.workspaceId, h.path, { name: 'idea', color: '#abc' })
      expect(made.name).toBe('idea')

      const state = await h.backend.list(h.workspaceId, h.path)
      // The row `create` answered is the row `list` shows.
      expect(state.branches.find((b) => b.name === 'idea')?.color).toBe('#abc')
      // Making a variation is not switching to it.
      expect(state.head).toBe('main')
    } finally {
      await h.cleanup()
    }
  })

  it('switches HEAD, naming the head it left, and the list agrees', async () => {
    const h = await create()
    try {
      await h.backend.create(h.workspaceId, h.path, { name: 'idea' })
      const switched = await h.backend.setHead(h.workspaceId, h.path, 'idea')
      expect(switched).toEqual({ head: 'idea', previousHead: 'main' })
      expect((await h.backend.list(h.workspaceId, h.path)).head).toBe('idea')
    } finally {
      await h.cleanup()
    }
  })

  it('renames a branch in place: the old name is gone and the new one is listed', async () => {
    const h = await create()
    try {
      await h.backend.create(h.workspaceId, h.path, { name: 'idea' })
      const renamed = await h.backend.rename(h.workspaceId, h.path, 'idea', 'plan')
      expect(renamed.branch.name).toBe('plan')

      const names = (await h.backend.list(h.workspaceId, h.path)).branches.map((b) => b.name)
      expect(names).toContain('plan')
      expect(names).not.toContain('idea')
    } finally {
      await h.cleanup()
    }
  })

  it('says which branch is HEAD in its stats', async () => {
    const h = await create()
    try {
      await h.backend.create(h.workspaceId, h.path, { name: 'idea' })
      await h.backend.setHead(h.workspaceId, h.path, 'idea')
      expect((await h.backend.getStats(h.workspaceId, h.path, 'idea')).isHead).toBe(true)
      expect((await h.backend.getStats(h.workspaceId, h.path, 'main')).isHead).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  it('a dry-run merge answers a preview and changes nothing', async () => {
    const h = await create()
    try {
      await h.backend.create(h.workspaceId, h.path, { name: 'idea' })
      const before = await h.backend.list(h.workspaceId, h.path)

      const preview = await h.backend.merge(h.workspaceId, h.path, 'idea', {
        into: 'main',
        dryRun: true,
      })
      // Badges are advisory (a CRDT merge never fails), so the answer is a
      // list, possibly empty, never an absence.
      expect(Array.isArray(preview.badges)).toBe(true)
      expect(preview.committed).toBeUndefined()

      expect(await h.backend.list(h.workspaceId, h.path)).toEqual(before)
    } finally {
      await h.cleanup()
    }
  })

  it('answers null for a variation that is not there, rather than throwing', async () => {
    const h = await create()
    try {
      expect(await h.backend.loadDocument(h.workspaceId, h.path, 'nowhere')).toBeNull()
    } finally {
      await h.cleanup()
    }
  })

  it('takes a removed branch off the list', async () => {
    const h = await create()
    try {
      await h.backend.create(h.workspaceId, h.path, { name: 'idea' })
      const removed = await h.backend.remove(h.workspaceId, h.path, 'idea')
      expect(removed.ok).toBe(true)
      expect(
        (await h.backend.list(h.workspaceId, h.path)).branches.map((b) => b.name),
      ).not.toContain('idea')
    } finally {
      await h.cleanup()
    }
  })
}

/**
 * The contract for a browser keeper with no record-holding backend: the
 * resting state, and refusals that are local and typed.
 *
 * This used to describe the browser keeper itself, which had no branches at
 * all. It has them now — and the contract did not become dead, it changed
 * SUBJECT. The page has no `BrowserBackend` for a markdown document, or
 * before one loads, and in those states the keeper must still answer: handing
 * the context a `null` instead falls through to its DAEMON fallback and
 * starts issuing requests to a daemon that is not there, which is the one
 * regression the provider was mounted to prevent.
 */
export function branchlessBackendContract(create: () => BranchesBackend): void {
  it('declares that it has no branches, and answers the resting state', async () => {
    const backend = create()
    expect(backend.hasBranches).toBe(false)
    expect((await backend.list('w', 'p')).head).toBe('main')
    expect(await backend.loadDocument('w', 'p', 'main')).toBeNull()
  })

  it('refuses every mutator with the typed error, never a request that failed', async () => {
    const backend = create()
    const refusals = await Promise.allSettled([
      backend.create('w', 'p', { name: 'idea' }),
      backend.remove('w', 'p', 'idea'),
      backend.rename('w', 'p', 'idea', 'plan'),
      backend.setHead('w', 'p', 'idea'),
      backend.getStats('w', 'p', 'idea'),
      backend.merge('w', 'p', 'idea', { into: 'main' }),
    ])
    for (const outcome of refusals) {
      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(BranchesUnsupportedError)
      }
    }
  })
}
