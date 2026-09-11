import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'
import { getLogger } from '../../../log.js'

const log = getLogger('migration-0023')

// ADR-0029 retired the branch: a proposal follows the document rather than
// forking it, so there is no tip to switch to and nothing left to merge. The
// UI went first (the chip, the merge dialog, the version list's lane column),
// then the client contract; this is the row underneath them.
//
// Discarded rather than migrated, because a branch tip has no shape to become.
// It is a frontier into a workspace record's oplog, meaningful only to a
// checkout nothing performs any more — there is no reader left to hand it to.
// A branch's WORK is not lost with the row: it is ops in the workspace record,
// which stays whole. What is lost is the label naming where to stand to see it.
//
// Two mechanics stop consulting these rows in the same increment, and both
// change what the daemon keeps:
//
//   - compaction's cut is now the earliest version row alone, so a fold no
//     longer holds history back for a tip. Measured before the change on a
//     one-tip fixture: the folded record was ~75% larger with the row.
//   - file-GC no longer counts a tip's checkout as a live reference set, so a
//     file only a tip referenced becomes collectable. That is correct — with
//     the row gone nothing can reach it — and it is still a deletion.
//
// `versions.branchName` deliberately stays for now. It is a label on a version
// row rather than a branch object, and it leaves through the published version
// wire and the browser's IndexedDB schema, so it is its own increment.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    const tdb = db as Kysely<{ branches: { name: string } }>
    const rows = await tdb.selectFrom('branches').select(['name']).execute()
    if (rows.length > 0) {
      log.warning(
        { count: rows.length },
        `${rows.length} branch rows discarded — ADR-0029 retired the branch`,
      )
    }
    await db.schema.dropTable('branches').execute()
  },
  async down(): Promise<void> {
    // A re-created table would be empty, and an empty branch table is not the
    // state this rolled back from. Pre-1.0 disposable-DB policy applies, the
    // same call 0017 made for the same reason.
    throw new Error('0023-drop-branches cannot be rolled back')
  },
}
