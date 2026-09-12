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
// EVERY EXISTING ROW GOES. A row written before this cannot gain a digest:
// the content a past checkpoint held is reachable only by checking the
// workspace record out at that row's frontiers, and a compacted record may no
// longer reach them at all. Carrying such rows would mean carrying a second
// read path — one that answers the old, wrong question — for the lifetime of
// the column. At 0.0.x, with the repo's no-compat policy for stored shapes,
// deleting them is the cheaper honesty: the read below is then one comparison
// with no branch, and no row can answer for a question it was never asked.
//
// What that costs a reader is real and worth naming: their saved points go,
// bookmarks they named included. The documents themselves are untouched — a
// version is a frontier plus a row, never a copy of the content — so what is
// lost is the ability to look back, not anything a document holds now.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    // Before the column, so nothing has to test for a value that only ever
    // means "written under the old question".
    await sql`delete from versions`.execute(db)
    await sql`alter table versions add column contentDigest text not null default ''`.execute(db)
  },
}
