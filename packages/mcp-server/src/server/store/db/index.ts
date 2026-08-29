import { mkdir } from 'node:fs/promises'
// @libsql/client is not imported directly anywhere in src — LibsqlDialect
// pulls it in transitively — but package.json still declares it as a direct
// dependency pinned newer (^0.17.3) than @libsql/kysely-libsql's own range
// (^0.8.0). Keep the direct pin: it is what forces the whole workspace onto
// the patched client version rather than whatever kysely-libsql's own
// (older) range would otherwise resolve to.
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { Kysely, sql } from 'kysely'
import { getDataDir } from '../../config.js'
import { databaseIsInsideDataDir, resolveDatabaseLocation } from './location.js'
import { writeDatabaseLocationRecord } from './location-record.js'
import type { DatabaseSchema } from './schema.js'

export type Database = Kysely<DatabaseSchema>

// Re-exported so the many callers that only want the filename do not have to
// know a resolver exists.
export { DB_FILENAME } from './location.js'

// One Kysely instance per getDataDir(). Tests swap getDataDir() via vi.mock so multiple
// distinct DBs may be opened across the lifetime of the process; each gets its
// own cache entry. Production only ever sees one getDataDir().
//
// The cache stores the *promise* of the resolved Database rather than the
// resolved value itself. Storing only the resolved value made concurrent
// first-time callers each build their own Kysely + libsql connection, with
// only the last `cache.set` winning — the earlier connections leaked because
// nobody held a reference to call `destroy()`. Caching the in-flight promise
// makes the lookup race-free at the cost of a single extra await on the cold
// path.
const cache = new Map<string, Promise<Database>>()

async function buildDb(dataDir: string): Promise<Database> {
  // The data directory is still made whatever the database is: blobs, version
  // thumbnails and the daemon's identity marker live there regardless of
  // where the rows do.
  await mkdir(dataDir, { recursive: true })
  const location = resolveDatabaseLocation(dataDir)
  // Written by whoever opens the database, because this is the only moment
  // the answer is available. `whiteboard server backup` runs later,
  // host-side, against a stopped deployment: it has neither this environment
  // nor any way to tell a live `whiteboard.db` from one an operator left
  // behind when they moved to libSQL.
  //
  // Before the connection, not after, so a deployment whose database server
  // is unreachable still leaves the right answer behind. That is exactly when
  // an operator reaches for a backup, and a missing record there would send
  // the guard back to the stale file it exists to catch. The location is a
  // property of the configuration, which is fully known here.
  //
  // Never throws: a directory that cannot hold this file costs a hint, not a
  // startup.
  await writeDatabaseLocationRecord(dataDir, databaseIsInsideDataDir(dataDir))
  const db = new Kysely<DatabaseSchema>({
    dialect: new LibsqlDialect(location),
  })
  // WAL, so readers and writers stop blocking each other.
  //
  // Under SQLite's default rollback journal, a read transaction's SHARED lock
  // blocks the EXCLUSIVE lock a commit needs — so anything that reads the
  // database for a while stops the daemon serving. Measured on the same
  // arrangement either way: a held reader plus a committing writer gives
  // `SQLITE_BUSY: database is locked` under `delete` and commits cleanly
  // under `wal`.
  //
  // It is also what ADR-0021 decision 3's hot snapshot rests on, though the
  // ADR does not say so. `whiteboard server backup` is a SEPARATE process
  // opening its own connection, and cross-process `VACUUM INTO` against a
  // database under active write was refused outright 3 times out of 3 under
  // the default, and succeeded 3 out of 3 in 9-22ms under WAL. The ADR's own
  // measurement was taken on the writing connection itself, where the locks
  // are already held and nothing contends.
  //
  // The cost is one this deployment has already accepted: WAL needs real
  // filesystem shared memory and does not work over a network filesystem —
  // and neither does the locking this store depends on regardless, which is
  // why ADR-0020 sends multi-instance deployments to a libSQL server rather
  // than a shared file.
  //
  // Persistent: the mode lives in the database header, so this both converts
  // an existing file once and sets it on a new one. It is deliberately NOT
  // fatal — a database that refuses the switch (a filesystem without the
  // shared-memory primitives) should still open and serve, more slowly, in
  // the mode it already had.
  await sql`PRAGMA journal_mode = WAL`.execute(db).catch(() => {})
  // libsql currently defaults `PRAGMA foreign_keys = ON` per connection (the
  // store/db/index.test FK case verifies this), so this call is belt-and-
  // suspenders rather than load-bearing. Vanilla SQLite does NOT default the
  // pragma on, and the setting is per-connection, so anyone swapping the
  // dialect would otherwise lose enforcement silently. The cost of one extra
  // call per cold-start connection is negligible.
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  return db
}

export function getDb(dataDir: string = getDataDir()): Promise<Database> {
  const existing = cache.get(dataDir)
  if (existing) return existing
  const pending = buildDb(dataDir)
  cache.set(dataDir, pending)
  pending.catch(() => {
    // Don't keep a rejected promise in the cache; a follow-up call should be
    // free to retry instead of replaying the original failure forever.
    if (cache.get(dataDir) === pending) {
      cache.delete(dataDir)
    }
  })
  return pending
}

// ── dispose-hook registry ─────────────────────────────────────────────
// Modules that own state keyed off a live DB connection (e.g. the
// document-store auto-compact debouncer) register a hook here so their
// pending timers / in-flight work are drained before the driver is
// destroyed. db/index.ts cannot import those modules directly (they import
// getDb from here, so importing back would create a cycle) — the registry
// inverts the dependency instead.
const disposeHooks: Array<() => Promise<void>> = []

// Returns an unregister function so dynamically-registered hooks (tests,
// short-lived owners) can remove themselves instead of accumulating in the
// module-scope registry.
export function registerDbDisposeHook(fn: () => Promise<void>): () => void {
  disposeHooks.push(fn)
  return () => {
    const index = disposeHooks.indexOf(fn)
    if (index !== -1) {
      disposeHooks.splice(index, 1)
    }
  }
}

// Never rejects: a misbehaving hook must not block driver teardown. Exported
// so the test-only createIsolatedDb() teardown path (test-helpers.ts) can
// run the same hooks before destroying its db, matching production's
// closeDb()/clearDbCache() behavior.
//
// Hooks are invoked through a wrapper that catches synchronous throws, not
// just rejected promises. A hook that throws before returning a promise would
// otherwise make the `disposeHooks.map((fn) => fn())` call itself throw,
// which propagates past Promise.allSettled entirely and breaks the
// never-rejects contract for callers like clearDbCache() that depend on it to
// still reach db.destroy().
export async function runDbDisposeHooks(): Promise<void> {
  await Promise.allSettled(
    disposeHooks.map(async (fn) => {
      await fn()
    }),
  )
}

export async function closeDb(dataDir: string = getDataDir()): Promise<void> {
  const pending = cache.get(dataDir)
  if (!pending) return
  // Run hooks BEFORE removing the cache entry. A hook (e.g. an already-fired
  // auto-compact) can re-enter getDb(dataDir) while draining; leaving the
  // entry cached lets that re-entrant call reuse the connection being
  // disposed instead of racing a replacement connection into the cache.
  await runDbDisposeHooks()
  cache.delete(dataDir)
  const db = await pending.catch(() => null)
  if (db) await db.destroy()
}

// Tests mutate getDataDir() via vi.mock; clearDbCache removes every cached instance
// without awaiting destroy() so the test setup can swap getDataDir() without leaking
// connections. Production code should prefer closeDb() to release the underlying
// libsql connection cleanly.
//
// This function is itself synchronous and fire-and-forget, so a caller that
// only calls clearDbCache() still cannot await quiescence of the disposed
// connections or their dispose hooks — use closeDb() (or, in tests,
// createIsolatedDb's handle.dispose()) when the caller needs to await
// teardown completing before proceeding.
export function clearDbCache(): void {
  // Snapshot the entries and remove each one only after its own dispose
  // hooks have run (not eagerly via a synchronous cache.clear()). Clearing
  // the whole cache up front would let a hook's re-entrant getDb() call for
  // the same dataDir find no cached entry and build a replacement connection
  // while the original is still being drained.
  for (const [dataDir, pending] of cache.entries()) {
    void pending
      .then(async (db) => {
        await runDbDisposeHooks()
        cache.delete(dataDir)
        await db.destroy()
      })
      .catch(() => {
        cache.delete(dataDir)
      })
  }
}

// Test-only seam. `createIsolatedDb` registers a memory-backed Database under
// a real dataDir so production code calling `getDb(getDataDir())` hits the same
// instance the test prepared. Production never reaches this path —
// `buildDb()` is the sole entry on the cold cache path.
export function injectCachedDb(dataDir: string, db: Database): void {
  cache.set(dataDir, Promise.resolve(db))
}

export function removeCachedDb(dataDir: string): void {
  cache.delete(dataDir)
}
