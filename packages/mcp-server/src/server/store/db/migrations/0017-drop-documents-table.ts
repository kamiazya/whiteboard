import type { Kysely, Migration } from 'kysely'
import { getLogger } from '../../../log.js'

const log = getLogger('migration-0017')

// USER-APPROVED plain break (2026-08-28, pre-1.0 disposable-DB policy): the
// documents table was the frozen inbox the daemon's startup fold drained
// into each workspace's tree record. Every real install is current, so the
// table and the fold that read it are retired outright — the workspace tree
// is the whole address book, full stop. A row still sitting in the inbox at
// this point was never folded (an old process crashed before its next boot,
// or the content underneath it never decoded), and there is no reader left
// to place it, so it is discarded rather than migrated.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    const tdb = db as Kysely<{ documents: { id: string } }>
    const rows = await tdb.selectFrom('documents').select(['id']).execute()
    if (rows.length > 0) {
      log.warning(
        { count: rows.length },
        `${rows.length} un-folded legacy inbox rows discarded — approved plain break`,
      )
    }
    await db.schema.dropTable('documents').execute()
  },
  async down(): Promise<void> {
    // The discarded rows are not restorable, and 0016 already removed the
    // FK a re-created table would need to mean the same thing; pre-1.0
    // disposable-DB policy applies.
    throw new Error('0017-drop-documents-table cannot be rolled back')
  },
}
