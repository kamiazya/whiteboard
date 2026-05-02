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
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { Kysely, SqliteDialect, sql } from 'kysely'
// libsql ships a native better-sqlite3-shaped binding next to @libsql/client.
// We bypass @libsql/client here because its `:memory:` path nulls the cached
// connection after every transaction, so subsequent non-transaction queries
// open a fresh empty in-memory DB. The native Database keeps a single handle
// for the lifetime of the instance, which is what `:memory:` needs.
import LibsqlNativeDatabase from 'libsql'
import { clearPrepareCache } from './prepare.js'
import {
  type Database,
  DB_FILENAME,
  injectCachedDb,
  removeCachedDb,
} from './index.js'
import { runMigrations } from './migrator.js'
import type { DatabaseSchema } from './schema.js'

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
  db: Database
  dispose(): Promise<void>
}

export async function createIsolatedDb(
  options: CreateIsolatedDbOptions,
): Promise<IsolatedDbHandle> {
  const { dataDir, memory = true } = options

  // Ensure the dataDir exists either way: store code writes blobs into it
  // even when the DB itself is in memory.
  await mkdir(dataDir, { recursive: true })

  // For file-backed mode keep the production dialect so we exercise the same
  // adapter / driver path. For memory mode swap to Kysely's SqliteDialect on
  // the libsql native binding — single Database instance, single connection,
  // `:memory:` actually retains state.
  const db = memory
    ? new Kysely<DatabaseSchema>({
        dialect: new SqliteDialect({
          // The Database class libsql exports is better-sqlite3-shaped; the
          // SqliteDialect constructor accepts any object that conforms to
          // that surface even if the type system disagrees.
          database: new LibsqlNativeDatabase(':memory:') as unknown as ConstructorParameters<
            typeof SqliteDialect
          >[0]['database'],
        }),
      })
    : new Kysely<DatabaseSchema>({
        dialect: new LibsqlDialect({ url: `file:${join(dataDir, DB_FILENAME)}` }),
      })

  // Same `PRAGMA foreign_keys = ON` belt-and-suspenders as production
  // `buildDb`. Memory-mode libsql defaults to ON in the version we ship, but
  // a future driver update could drift; the file-backed db/index test still
  // catches that regression on the production path.
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  await runMigrations(db)
  injectCachedDb(dataDir, db)

  return {
    db,
    async dispose() {
      removeCachedDb(dataDir)
      // prepareDataDir memoizes per-dataDir; clearing keeps the next test free
      // to call prepareDataDir again without picking up the disposed promise.
      clearPrepareCache()
      await db.destroy()
    },
  }
}
