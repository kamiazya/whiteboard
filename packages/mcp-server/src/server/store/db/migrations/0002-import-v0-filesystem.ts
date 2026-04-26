import type { Kysely, Migration } from 'kysely'
import { DATA_DIR } from '../../../config.js'
import { importV0Filesystem } from '../import-v0-filesystem.js'
import type { DatabaseSchema } from '../schema.js'

// One-shot importer that hydrates the freshly-initialized SQLite tables from
// the legacy on-disk layout (~/.whiteboard/{workspaceId}/{slug}.loro etc.).
//
// The actual logic lives in import-v0-filesystem.ts so it stays testable
// in isolation. The migration entry exists so kysely's __drizzle-style
// migration log records that the import ran, even if it imported zero
// workspaces (fresh installs). Down is a no-op because the importer
// already moves legacy files into .legacy-bak/ before deleting them, so
// rolling back the schema migration above (0001-init) is enough to revert.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await importV0Filesystem({ db: db as Kysely<DatabaseSchema>, dataDir: DATA_DIR })
  },

  async down(): Promise<void> {
    // Quarantine buckets remain on disk so an operator can restore them by
    // hand. No automated reversal is attempted.
  },
}
