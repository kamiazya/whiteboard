import { type MigrationProvider, Migrator } from 'kysely'
import { IncompatibleDatabaseError } from './incompatible-database.js'
import type { Database } from './index.js'
import { migrations } from './migrations/index.js'

// kysely throws this phrase when the DB's migration log records a migration the
// current provider does not ship (the "applied but missing from code" case).
// This is an upstream message signature — kysely has no typed error for it — so
// it can break if kysely changes the wording on a future upgrade. The
// migrator.test.ts "unknown migration" case exercises the real kysely path and
// will go red if the phrase drifts, flagging the need to update this match.
const KYSELY_CORRUPTED_MIGRATIONS_SIGNATURE = 'corrupted migrations'

// Static migration provider. Migrations are imported eagerly so the runtime
// list is whatever ships with the bundle. This intentionally diverges from
// kysely's FileMigrationProvider so dist builds do not have to ship loose .js
// files alongside the bundled server.
class StaticMigrationProvider implements MigrationProvider {
  async getMigrations() {
    return migrations
  }
}

export async function runMigrations(db: Database): Promise<void> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() })
  const { error, results } = await migrator.migrateToLatest()
  if (error) {
    const failed = results?.find((r) => r.status === 'Error')?.migrationName
    const detail = error instanceof Error ? error.message : String(error)

    // An incompatible migration history (DB created by a build that ships a
    // migration this build lacks) is unrecoverable by re-running. Re-frame the
    // cryptic kysely error into an actionable one pointing at the disposable-DB
    // recovery steps, instead of letting it surface as an opaque startup failure.
    if (detail.includes(KYSELY_CORRUPTED_MIGRATIONS_SIGNATURE)) {
      throw new IncompatibleDatabaseError(
        'Database is incompatible with this build — its migration history records a ' +
          'migration this version does not ship. Pre-1.0 databases are disposable: ' +
          're-create it by removing ~/.whiteboard/whiteboard.db and restarting. ' +
          'See docs/contributing/mcp-debugging.md (Database Migration Errors).',
        { cause: error },
      )
    }

    // A migration that walks the data dir's filesystem tree (e.g.
    // 0011-import-fs-blobs reading {dataDir}/blobs/**) can hit a permission
    // error unrelated to the database itself. Point at the fix instead of
    // surfacing the raw "EACCES ... scandir '<path>'" errno message, which
    // names an implementation detail no user can act on directly.
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EACCES') {
      throw new Error(
        `Database migration failed${failed ? ` at ${failed}` : ''}: permission denied reading ` +
          'the data directory. Check filesystem permissions on the workspace blob directories ' +
          'under <data dir>/blobs and restart. See docs/contributing/mcp-debugging.md ' +
          '(Database Migration Errors).',
        { cause: error },
      )
    }

    throw new Error(`Database migration failed${failed ? ` at ${failed}` : ''}: ${detail}`, {
      cause: error,
    })
  }
}
