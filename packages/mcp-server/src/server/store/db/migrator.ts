import { sql } from 'kysely'
import { type MigrationProvider, Migrator } from 'kysely/migration'
import { isErrnoCode } from '../../../shared/errno.js'
import { IncompatibleDatabaseError } from './incompatible-database.js'
import { migrations } from './migrations/index.js'
import { PUBLISHED_MIGRATION_NAMES } from './published-migration-names.js'
import type { Database } from './schema.js'

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

// The migration names the database recorded that this build does not ship.
// Read from the log rather than parsed out of kysely's message, which names
// only the first one.
async function unknownRecordedMigrations(db: Database): Promise<string[]> {
  const known = new Set(Object.keys(migrations))
  const { rows } = await sql<{ name: string }>`select name from kysely_migration`.execute(db)
  return rows.map((r) => r.name).filter((name) => !known.has(name))
}

// Migration names sort alphabetically (kysely requires it), so a recorded name
// past the last one this build ships was written by a release newer than this
// one. A missing name inside the published range is a rename or a dropped
// migration instead, which no newer build would read either.
function incompatibleDatabaseMessage(unknown: readonly string[], where: string): string {
  const lastShipped = PUBLISHED_MIGRATION_NAMES[PUBLISHED_MIGRATION_NAMES.length - 1]
  const newer = unknown.filter((name) => name > lastShipped)
  if (newer.length > 0) {
    return (
      `The database at ${where} was migrated by a newer release of whiteboard: it records ` +
      `${newer.join(', ')}, which this build (last migration ${lastShipped}) does not ship. ` +
      'Upgrade this build to the latest @kamiazya/whiteboard-mcp (for example ' +
      '`npx -y @kamiazya/whiteboard-mcp@latest`) and stop any older daemon on the same data ' +
      'directory. Keep the database as it is: it holds your documents and the newer build ' +
      'reads it unchanged.'
    )
  }
  return (
    `The database at ${where} is incompatible with this build: its migration history ` +
    `records ${unknown.length > 0 ? unknown.join(', ') : 'a migration'}, which this version does ` +
    'not ship, usually because it was renamed. Pre-1.0 databases are disposable: re-create it ' +
    `by removing ${where} and restarting. ` +
    'See docs/contributing/mcp-debugging.md (Database Migration Errors).'
  )
}

/**
 * `where` names the database in an error (its path or URL): this function sees
 * only the connection, and the data directory is configurable, so a message
 * with a fixed location would point at the wrong file.
 */
export async function runMigrations(db: Database, where = 'this deployment'): Promise<void> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() })
  const { error, results } = await migrator.migrateToLatest()
  if (error) {
    const failed = results?.find((r) => r.status === 'Error')?.migrationName
    const detail = error instanceof Error ? error.message : String(error)

    // An incompatible migration history (DB created by a build that ships a
    // migration this build lacks) is unrecoverable by re-running. Re-frame the
    // cryptic kysely error into an actionable one: upgrade for a newer
    // database, re-create for a renamed migration.
    if (detail.includes(KYSELY_CORRUPTED_MIGRATIONS_SIGNATURE)) {
      throw new IncompatibleDatabaseError(
        incompatibleDatabaseMessage(await unknownRecordedMigrations(db).catch(() => []), where),
        { cause: error },
      )
    }

    // A migration that walks the data dir's filesystem tree (e.g.
    // 0011-import-fs-blobs reading {dataDir}/blobs/**) can hit a permission
    // error unrelated to the database itself. Point at the fix instead of
    // surfacing the raw "EACCES ... scandir '<path>'" errno message, which
    // names an implementation detail no user can act on directly.
    if (isErrnoCode(error, 'EACCES')) {
      throw new Error(
        `Database migration failed${failed ? ` at ${failed}` : ''}: permission denied reading ` +
          'the data directory. Check filesystem permissions on the blob directories under ' +
          '<data dir>/tenants/<tenant>/blobs (or <data dir>/blobs on a data directory this ' +
          'daemon has not started yet) and restart. See docs/contributing/mcp-debugging.md ' +
          '(Database Migration Errors).',
        { cause: error },
      )
    }

    throw new Error(`Database migration failed${failed ? ` at ${failed}` : ''}: ${detail}`, {
      cause: error,
    })
  }
}
