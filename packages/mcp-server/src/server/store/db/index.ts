import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { Kysely, sql } from 'kysely'
import { DATA_DIR } from '../../config.js'
import type { DatabaseSchema } from './schema.js'

export type Database = Kysely<DatabaseSchema>

export const DB_FILENAME = 'whiteboard.db'

// One Kysely instance per DATA_DIR. Tests swap DATA_DIR via vi.mock so multiple
// distinct DBs may be opened across the lifetime of the process; each gets its
// own cache entry. Production only ever sees one DATA_DIR.
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
  await mkdir(dataDir, { recursive: true })
  const url = `file:${join(dataDir, DB_FILENAME)}`
  const db = new Kysely<DatabaseSchema>({
    dialect: new LibsqlDialect({ url }),
  })
  // libsql currently defaults `PRAGMA foreign_keys = ON` per connection (the
  // store/db/index.test FK case verifies this), so this call is belt-and-
  // suspenders rather than load-bearing. Vanilla SQLite does NOT default the
  // pragma on, and the setting is per-connection, so anyone swapping the
  // dialect would otherwise lose enforcement silently. The cost of one extra
  // call per cold-start connection is negligible.
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  return db
}

export function getDb(dataDir: string = DATA_DIR): Promise<Database> {
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

export async function closeDb(dataDir: string = DATA_DIR): Promise<void> {
  const pending = cache.get(dataDir)
  if (!pending) return
  cache.delete(dataDir)
  const db = await pending.catch(() => null)
  if (db) await db.destroy()
}

// Tests mutate DATA_DIR via vi.mock; clearDbCache removes every cached instance
// without awaiting destroy() so the test setup can swap DATA_DIR without leaking
// connections. Production code should prefer closeDb() to release the underlying
// libsql connection cleanly.
export function clearDbCache(): void {
  for (const pending of cache.values()) {
    void pending.then((db) => db.destroy()).catch(() => {})
  }
  cache.clear()
}

// Test-only seam. `createIsolatedDb` registers a memory-backed Database under
// a real dataDir so production code calling `getDb(DATA_DIR)` hits the same
// instance the test prepared. Production never reaches this path —
// `buildDb()` is the sole entry on the cold cache path.
export function injectCachedDb(dataDir: string, db: Database): void {
  cache.set(dataDir, Promise.resolve(db))
}

export function removeCachedDb(dataDir: string): void {
  cache.delete(dataDir)
}
