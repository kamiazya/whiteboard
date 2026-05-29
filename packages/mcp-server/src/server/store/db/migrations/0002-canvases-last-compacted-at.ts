import type { Migration } from 'kysely'

// No-op forward-compat migration.
//
// The published mcp-server-v0.0.6 release shipped a 0002-canvases-last-compacted-at
// migration (it added a `canvases.last_compacted_at` column). The current schema
// dropped that column and the last-compacted-at feature entirely: 0001-init no longer
// defines it and no code references `last_compacted_at`. Databases created by running
// the v0.0.6 daemon still record 0002-canvases-last-compacted-at as applied, so kysely's
// Migrator would otherwise reject them with
//   "corrupted migrations: previously executed migration 0002-canvases-last-compacted-at is missing"
// and the daemon would fail to start.
//
// Re-registering the name as a no-op makes the provider a superset of any existing DB's
// migration log, so migrateToLatest() passes. This intentionally does NOT restore the
// feature: fresh databases gain nothing, and the leftover column on upgraded v0.0.6
// databases is harmless because no current code reads it. Do not repurpose this name.
//
// The next free migration index is 0003.
export const migration: Migration = {
  async up(): Promise<void> {},
  async down(): Promise<void> {},
}
