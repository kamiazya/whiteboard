import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// The identity of the CONTENT a checkpoint was taken of, so "has this
// document changed since its last version?" can be asked about the document
// rather than about the workspace.
//
// A version's `frontiers` belong to the WORKSPACE record — one Loro document
// holding every document in the workspace — so any sibling's edit moves them
// and a frontier comparison answers "somebody edited something here". The
// digest is per document and derived from the merged content itself
// (`contentDigestOf`), so it answers about one.
//
// `''` on an existing row means "taken before the digest was recorded", not
// "empty content": nothing can be reconstructed for those rows, since the
// content a past checkpoint held is only reachable by checking the record
// out at its frontiers. The read falls back to the frontier comparison for
// them, which is the behaviour they were written under.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table versions add column contentDigest text not null default ''`.execute(db)
  },
}
