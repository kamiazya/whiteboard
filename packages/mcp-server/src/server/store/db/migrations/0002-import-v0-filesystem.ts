import type { Migration } from 'kysely'

// The v0 importer is **not** a kysely migration because it needs the live
// dataDir for the running process, not the static DATA_DIR import that
// migrations would close over. Tests routinely vi.mock('../../../config.js')
// so the schema can run against a temp directory; the importer needs the same
// per-test dataDir.
//
// Instead, prepareDataDir() runs the importer after migrations finish.
// This migration is reserved as a placeholder so kysely's internal migration
// log records that the import contract was applied at this version, and so
// future schema changes can downgrade-rebuild the importer state cleanly.
export const migration: Migration = {
  async up(): Promise<void> {
    // intentionally empty
  },

  async down(): Promise<void> {
    // intentionally empty
  },
}
