import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Bench tests for the connection-cache + per-connection FK pragma. These were
// added after the initial cut of this PR shipped a stale-connection-cache /
// non-enforced-FK pair of bugs that the existing migration / store unit tests
// happily passed. Treat this as the canary suite for db/index.ts contracts.

let tempDir: string

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { getDb, closeDb, clearDbCache, registerDbDisposeHook, runDbDisposeHooks } = await import(
  './index.js'
)
const { prepareDataDir, clearPrepareCache } = await import('./prepare.js')

// registerDbDisposeHook has no unregister counterpart, so this file registers
// exactly one hook at module scope and routes it through a swappable
// indirection instead of calling registerDbDisposeHook per test (which would
// pile up hooks that outlive the test that registered them).
let activeHookRun: (() => Promise<void>) | null = null
registerDbDisposeHook(async () => {
  if (activeHookRun) await activeHookRun()
})

// A second hook, registered without an `async` wrapper, so a configured throw
// happens synchronously inside the `disposeHooks.map((fn) => fn())` call
// rather than surfacing as a rejected promise. Kept separate from
// activeHookRun above because that hook's own `async` keyword would convert
// any throw inside it into a rejection before runDbDisposeHooks ever sees it.
let throwSynchronouslyOnDispose = false
registerDbDisposeHook(() => {
  if (throwSynchronouslyOnDispose) {
    throw new Error('sync dispose hook boom')
  }
  return Promise.resolve()
})

describe('getDb / closeDb', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-db-index-test-'))
    clearDbCache()
    clearPrepareCache()
    activeHookRun = null
    throwSynchronouslyOnDispose = false
  })

  afterEach(async () => {
    await closeDb(tempDir).catch(() => {})
    clearDbCache()
    clearPrepareCache()
    activeHookRun = null
    throwSynchronouslyOnDispose = false
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns a single Database instance even when many concurrent callers race the cache', async () => {
    // The naive "store the resolved Database, not the pending promise" cache
    // would build N connections here and silently leak N-1 of them. Anchor
    // the behavior so future refactors of getDb keep the race-free contract.
    const dbs = await Promise.all(Array.from({ length: 32 }, () => getDb(tempDir)))
    const unique = new Set(dbs)
    expect(unique.size).toBe(1)
  })

  it('drops the cache entry when the build promise rejects so a later call can retry', async () => {
    const bogus = '/dev/null/cannot-make-a-dir-here'
    await expect(getDb(bogus)).rejects.toBeDefined()
    // Same key, second call: the failure must not be sticky.
    await expect(getDb(bogus)).rejects.toBeDefined()
    // And a healthy dir keeps working alongside the failed key.
    const ok = await getDb(tempDir)
    expect(ok).toBeDefined()
  })

  it('enforces foreign-key constraints on the connection used by the application', async () => {
    // The contract is "FK violations from the application throw". libsql's
    // current dialect happens to default `PRAGMA foreign_keys = ON`, but
    // vanilla SQLite does not. We deliberately assert the visible behavior
    // (orphan insert throws, cascade delete prunes children) rather than the
    // pragma value, so this test still flags any future regression — driver
    // swap, accidental pragma reset, or rebuilt schema without FK clauses.
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)

    // The branches table FKs canvases.id with ON DELETE CASCADE. Inserting a
    // branch row whose canvasId does not exist must throw, and deleting a
    // canvas must also delete its branches.
    const now = Date.now()
    await db
      .insertInto('workspaces')
      .values({ id: 'ws-fk', displayName: null, createdAt: now, updatedAt: now })
      .execute()
    await db
      .insertInto('canvases')
      .values({
        id: 'cv-fk',
        workspaceId: 'ws-fk',
        slug: 'main',
        displayName: null,
        isPinned: 0,
        pinOrder: null,
        currentBranch: 'main',
        createdAt: now,
        updatedAt: now,
      })
      .execute()
    await db
      .insertInto('branches')
      .values({
        canvasId: 'cv-fk',
        name: 'main',
        tipFrontiers: '',
        color: null,
        sourceBranchName: null,
        sourceVersionId: null,
        createdAt: now,
      })
      .execute()

    await expect(
      db
        .insertInto('branches')
        .values({
          canvasId: 'cv-does-not-exist',
          name: 'orphan',
          tipFrontiers: '',
          color: null,
          sourceBranchName: null,
          sourceVersionId: null,
          createdAt: now,
        })
        .execute(),
    ).rejects.toThrow(/FOREIGN KEY/i)

    await db.deleteFrom('canvases').where('id', '=', 'cv-fk').execute()
    const remaining = await db
      .selectFrom('branches')
      .selectAll()
      .where('canvasId', '=', 'cv-fk')
      .execute()
    expect(remaining).toEqual([])
  })
})

describe('dispose hooks (registerDbDisposeHook / runDbDisposeHooks)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-db-index-hooks-test-'))
    clearDbCache()
    clearPrepareCache()
    activeHookRun = null
    throwSynchronouslyOnDispose = false
  })

  afterEach(async () => {
    await closeDb(tempDir).catch(() => {})
    clearDbCache()
    clearPrepareCache()
    activeHookRun = null
    throwSynchronouslyOnDispose = false
    await rm(tempDir, { recursive: true, force: true })
  })

  it('closeDb() runs registered dispose hooks while the connection is still open, then destroys it', async () => {
    const db = await getDb(tempDir)
    let queriedDuringHook = false
    activeHookRun = async () => {
      // The connection must still be usable from inside the hook — proves
      // hooks run before destroy(), not after.
      await sql`SELECT 1`.execute(db)
      queriedDuringHook = true
    }

    await closeDb(tempDir)

    expect(queriedDuringHook).toBe(true)
    await expect(sql`SELECT 1`.execute(db)).rejects.toThrow()
  })

  it('closeDb() keeps the cache entry live while hooks run, so a re-entrant getDb() reuses the disposing connection instead of building a replacement', async () => {
    const db = await getDb(tempDir)
    let reentrantDb: Awaited<ReturnType<typeof getDb>> | null = null
    activeHookRun = async () => {
      // Simulates an auto-compact hook whose in-flight work resumes and
      // calls back into getDb() for the same dataDir while draining.
      reentrantDb = await getDb(tempDir)
    }

    await closeDb(tempDir)

    expect(reentrantDb).toBe(db)
  })

  it('closeDb() swallows a throwing/rejecting dispose hook instead of blocking teardown', async () => {
    await getDb(tempDir)
    activeHookRun = async () => {
      throw new Error('boom')
    }

    await expect(closeDb(tempDir)).resolves.toBeUndefined()
  })

  it('clearDbCache() runs registered dispose hooks before destroying the cached connection', async () => {
    const db = await getDb(tempDir)
    let queriedDuringHook = false
    activeHookRun = async () => {
      await sql`SELECT 1`.execute(db)
      queriedDuringHook = true
    }

    clearDbCache()

    await vi.waitFor(() => {
      expect(queriedDuringHook).toBe(true)
    })
    await vi.waitFor(async () => {
      await expect(sql`SELECT 1`.execute(db)).rejects.toThrow()
    })
  })

  it('clearDbCache() keeps the cache entry live while hooks run, so a re-entrant getDb() reuses the disposing connection instead of building a replacement', async () => {
    const db = await getDb(tempDir)
    let reentrantDb: Awaited<ReturnType<typeof getDb>> | null = null
    activeHookRun = async () => {
      reentrantDb = await getDb(tempDir)
    }

    clearDbCache()

    await vi.waitFor(() => {
      expect(reentrantDb).toBe(db)
    })
  })

  it('clearDbCache() tolerates a throwing/rejecting dispose hook and still destroys the connection', async () => {
    const db = await getDb(tempDir)
    activeHookRun = async () => {
      throw new Error('boom')
    }

    clearDbCache()

    // runDbDisposeHooks() (Promise.allSettled internally) must swallow the
    // throw so clearDbCache's chain still reaches destroy() instead of
    // leaving the connection cached and alive forever.
    await vi.waitFor(async () => {
      await expect(sql`SELECT 1`.execute(db)).rejects.toThrow()
    })
  })

  it('runDbDisposeHooks() swallows a hook that throws synchronously before returning a promise', async () => {
    throwSynchronouslyOnDispose = true

    await expect(runDbDisposeHooks()).resolves.toBeUndefined()
  })

  it('clearDbCache() still destroys the connection when a dispose hook throws synchronously', async () => {
    const db = await getDb(tempDir)
    throwSynchronouslyOnDispose = true

    clearDbCache()

    // A hook that throws synchronously (rather than returning a rejected
    // promise) must not make clearDbCache's chain reject before reaching
    // db.destroy() — that would leave the connection cached-but-orphaned.
    await vi.waitFor(async () => {
      await expect(sql`SELECT 1`.execute(db)).rejects.toThrow()
    })
  })
})
