import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// The evidence a person was present when a row was written (ADR-0039): the
// raw WebAuthn assertion as JSON, `attestationSchema`'s shape, parsed on
// every read so a row carrying something else reads as carrying nothing.
//
// Nullable with no default, and EVERY EXISTING ROW STAYS. Most rows never
// carry one by design — decision 4 asks for a gesture at a trust boundary and
// nowhere else — so absence means "not asked", which is as true of a row
// written before this column as of one written after. 0026 deleted rows
// because carrying them would have kept a wrong comparison alive; nothing
// here compares, so nothing is wrong about an old row.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('versions').addColumn('attestation', 'text').execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('versions').dropColumn('attestation').execute()
  },
}
