import { describeThrown } from '@kamiazya/whiteboard-model'
import { sql } from 'kysely'
import { type MigrationProvider, Migrator } from 'kysely/migration'
import { IncompatibleDatabaseError, retiredStorageMessage } from './incompatible-database.js'
import { migrations } from './migrations/index.js'
import { PUBLISHED_MIGRATION_NAMES, RETIRED_MIGRATION_NAMES } from './published-migration-names.js'
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

const RETIRED = new Set<string>(RETIRED_MIGRATION_NAMES)

// A retired name is checked first: it sorts after the baseline, so the
// ordering test below would misread it as a newer release's. Otherwise names
// sort alphabetically (kysely requires it), so a recorded name past the last
// one this build ships was written by a release newer than this one, and a
// missing name inside the published range is a rename or a dropped migration,
// which no newer build would read either.
function incompatibleDatabaseMessage(unknown: readonly string[], where: string): string {
  if (unknown.some((name) => RETIRED.has(name))) {
    return retiredStorageMessage(`The database at ${where}`)
  }
  const lastShipped = PUBLISHED_MIGRATION_NAMES[PUBLISHED_MIGRATION_NAMES.length - 1]
  const newer = unknown.filter((name) => name > lastShipped)
  if (newer.length > 0) {
    return (
      `The database at ${where} was migrated by a newer release of whiteboard: it records ` +
      `${newer.join(', ')}, which this build (last migration ${lastShipped}) does not ship. ` +
      'Upgrade this build to the latest @kamiazya/whiteboard-mcp (for example ' +
      '`npx -y @kamiazya/whiteboard-mcp@latest`) — or, in a source checkout, rebuild it with ' +
      '`pnpm build` — and stop any older daemon on the same data ' +
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
    const detail = describeThrown(error)

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

    throw new Error(`Database migration failed${failed ? ` at ${failed}` : ''}: ${detail}`, {
      cause: error,
    })
  }
}
