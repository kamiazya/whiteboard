import { Migrator, type MigrationProvider } from 'kysely'
import { migrations } from './migrations/index.js'
import type { Database } from './index.js'

// Static migration provider. Migrations are imported eagerly so the runtime
// list is whatever ships with the bundle. This intentionally diverges from
// kysely's FileMigrationProvider so dist builds do not have to ship loose .js
// files alongside the bundled server.
export class StaticMigrationProvider implements MigrationProvider {
  async getMigrations() {
    return migrations
  }
}

export async function runMigrations(db: Database): Promise<void> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() })
  const { error, results } = await migrator.migrateToLatest()
  if (error) {
    const failed = results?.find((r) => r.status === 'Error')?.migrationName
    throw new Error(
      `Database migration failed${failed ? ` at ${failed}` : ''}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
