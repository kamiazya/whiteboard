// Test-only helper to give store tests a fast, isolated database without
// paying for migrations against a real `whiteboard.db` on every `beforeEach`.
//
// Memory mode uses libsql's `mode=memory&cache=shared` URL with a unique name
// per call. The unique name matters: libsql treats the URL as the database
// identity, so two helpers sharing the same name would also share rows even
// though each calls back through its own connection. Production never imports
// this module — it lives next to `db/index.ts` only so it can reach the
// `injectCachedDb` seam without exporting it from the public surface.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Kysely, type QueryExecutorProvider, SqliteDialect, sql } from 'kysely'
import { type MigrationProvider, Migrator } from 'kysely/migration'
// libsql ships a native better-sqlite3-shaped binding next to @libsql/client.
// We bypass @libsql/client here because its `:memory:` path nulls the cached
// connection after every transaction, so subsequent non-transaction queries
// open a fresh empty in-memory DB. The native Database keeps a single handle
// for the lifetime of the instance, which is what `:memory:` needs.
import LibsqlNativeDatabase from 'libsql'
import { busyRetryingDialect } from './busy-retry.js'
import { DB_FILENAME, getDb, injectCachedDb, removeCachedDb, runDbDisposeHooks } from './index.js'
import { migrations } from './migrations/index.js'
import { runMigrations } from './migrator.js'
import { clearPrepareCache } from './prepare.js'
import type { Database, DatabaseSchema } from './schema.js'
import type { TenantDatabase } from './tenant-database.js'

export interface CreateIsolatedDbOptions {
  // Real filesystem path the rest of the store still uses for blobs / exports
  // / versions / files. The DB connection itself may be memory-backed even
  // when blobs land here.
  dataDir: string
  // Default true. memory:false drops back to the same `file:` URL production
  // uses so `db/index.test.ts` and `db/migrator.test.ts` can keep exercising
  // the on-disk driver behaviour they were written for.
  memory?: boolean
}

export interface IsolatedDbHandle {
  /** What a store is handed in production: bound to the self-host tenant. */
  db: TenantDatabase
  /** The unscoped database, for a test that inspects physical tables. */
  rawDb: Database
  dispose(): Promise<void>
}

// The Database class libsql exports is better-sqlite3-shaped; SqliteDialect
// accepts any object that conforms to that surface even if the type system
// disagrees, so the cast lives here once for every helper in this file.
function nativeSqliteDialect(location: string): SqliteDialect {
  return new SqliteDialect({
    database: new LibsqlNativeDatabase(location) as unknown as ConstructorParameters<
      typeof SqliteDialect
    >[0]['database'],
  })
}

// For file-backed mode keep the production dialect so we exercise the same
// adapter / driver path. For memory mode swap to Kysely's SqliteDialect on
// the libsql native binding — single Database instance, single connection,
// `:memory:` actually retains state.
function openIsolated(dataDir: string, memory: boolean): Database {
  return memory
    ? new Kysely<DatabaseSchema>({ dialect: nativeSqliteDialect(':memory:') })
    : new Kysely<DatabaseSchema>({
        dialect: busyRetryingDialect({ url: `file:${join(dataDir, DB_FILENAME)}` }),
      })
}

export async function createIsolatedDb(
  options: CreateIsolatedDbOptions,
): Promise<IsolatedDbHandle> {
  const { dataDir, memory = true } = options

  // Ensure the dataDir exists either way: store code writes blobs into it
  // even when the DB itself is in memory.
  await mkdir(dataDir, { recursive: true })

  const db = openIsolated(dataDir, memory)

  // Same `PRAGMA foreign_keys = ON` belt-and-suspenders as production
  // `buildDb`. Memory-mode libsql defaults to ON in the version we ship, but
  // a future driver update could drift; the file-backed db/index test still
  // catches that regression on the production path.
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  await runMigrations(db)
  injectCachedDb(dataDir, db)

  return {
    // From getDb, so a store reaching for `getDb(dataDir)` finds this very handle.
    db: await getDb(dataDir),
    rawDb: db,
    async dispose() {
      // Drain registered dispose hooks (e.g. document-store's pending
      // auto-compact timers/in-flight compactions) before removing the cache
      // entry or destroying the driver, matching production's
      // closeDb()/clearDbCacheForTests() ordering. Removing the cache entry first
      // would let a hook's re-entrant getDb(dataDir) call race a replacement
      // connection into the cache while this one is still being drained.
      await runDbDisposeHooks()
      removeCachedDb(dataDir)
      // prepareDataDir memoizes per-dataDir; clearing keeps the next test free
      // to call prepareDataDir again without picking up the disposed promise.
      clearPrepareCache()
      await db.destroy()
    },
  }
}

// A table-agnostic handle: a migration test reads rows in the shape a schema
// had BEFORE the migration under test, which `DatabaseSchema` (the head) no
// longer describes.
export type AnyTables = Record<string, Record<string, unknown>>

/** The migrator over the real migration log, for a database a test already holds. */
export function migratorFor<DB>(db: Kysely<DB>): Migrator {
  const provider: MigrationProvider = { getMigrations: async () => migrations }
  return new Migrator({ db: db as never, provider })
}

export interface MigrationHarness<DB = AnyTables> {
  db: Kysely<DB>
  /** Applies the log up to and including `name`; throws the migration's own error. */
  migrateTo(name: string): Promise<void>
  migrateToHead(): Promise<void>
  /** Runs to head and hands back the error instead of throwing it, for a test about failing. */
  migrateToHeadRaw(): Promise<unknown>
}

/**
 * A database a migration test walks the log over one step at a time, unlike
 * `createIsolatedDb`, which hands back a fully migrated one.
 *
 * With a `dataDir` the database is the `whiteboard.db` file production opens
 * (the log's FILE behaviour — renames, blob moves — is what those tests are
 * about); without one it is `:memory:`, for a test that calls a single
 * migration's `up`/`down` directly. Foreign keys are on either way, as in
 * production's `buildDb`, because a migration that only works with them off
 * is not one an install can run.
 */
export async function openMigrationHarness<DB = AnyTables>(
  dataDir?: string,
): Promise<MigrationHarness<DB>> {
  const db = new Kysely<DB>({
    dialect: nativeSqliteDialect(dataDir === undefined ? ':memory:' : join(dataDir, DB_FILENAME)),
  })
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  const migrator = migratorFor(db)
  const unwrap = (error: unknown): void => {
    if (error !== undefined) throw error
  }
  return {
    db,
    async migrateTo(name) {
      unwrap((await migrator.migrateTo(name)).error)
    },
    async migrateToHead() {
      unwrap((await migrator.migrateToLatest()).error)
    },
    async migrateToHeadRaw() {
      return (await migrator.migrateToLatest()).error
    },
  }
}

/**
 * Whether a physical table exists. Takes the UNSCOPED handle: the
 * tenant-bound one refuses a raw statement, and `sqlite_master` is no tenant's.
 */
export async function tableExists(db: QueryExecutorProvider, name: string): Promise<boolean> {
  const { rows } = await sql<{
    name: string
  }>`select name from sqlite_master where type = 'table' and name = ${name}`.execute(db)
  return rows.length > 0
}
