import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import type { Kysely } from 'kysely'
import { getDataDir } from '../../../config.js'
import { getLogger } from '../../../log.js'

// The id spaces converged on the ULID (ADR-0007 decision 5): the port's
// DocumentEntry accepts nothing else, and since the index reads `canvases`
// directly a nanoid row reaches every agent-facing caller. listDocuments
// skips such rows with a warning so one of them cannot darken a whole
// listing — this migration is what empties that skip: each pre-convergence
// row gets a fresh ULID, and everything keyed on the old id moves with it
// in the same transaction (versions and branches carry a foreign key onto
// canvases.id, so the parent and children cannot move separately).
//
// The `.loro` blob under blobs/<workspaceId>/canvas/ is named by the id, so
// it is renamed too — after the row updates, because a missing blob must not
// fail bootstrap (a row can outlive its blob: a crashed delete, a
// hand-pruned data dir), while a renamed blob with an un-renamed row WOULD
// be an outage. fs is fine here: migrations are composition-root code.

interface CanvasRow {
  id: string
  workspaceId: string
  slug: string
  displayName: string | null
  isPinned: number
  pinOrder: number | null
  currentBranch: string
  createdAt: number
  updatedAt: number
  lastCompactedAt: number | null
  kind: string | null
}

const CANONICAL_ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

export const migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    const tdb = db as Kysely<{
      canvases: CanvasRow
      versions: { canvasId: string }
      branches: { canvasId: string }
    }>
    const log = getLogger('migration-0008')

    const rows = await tdb.selectFrom('canvases').selectAll().execute()
    const legacy = rows.filter((row) => !CANONICAL_ULID.test(row.id))
    if (legacy.length === 0) return

    // A blob rename is the one step here a transaction cannot roll back. If
    // a LATER row fails, the migrator rolls the DB back to nanoid ids — and
    // a blob already renamed to a fresh ULID would be orphaned FOREVER,
    // because the ULID is regenerated on the next attempt and nothing could
    // ever find it again. So every completed rename is recorded, and on any
    // failure they are renamed BACK (best effort, loudly) before the error
    // propagates: the disk then matches the rolled-back DB and the
    // migration is safe to retry.
    const completedRenames: { from: string; to: string }[] = []
    try {
      await rewriteLegacyRows()
    } catch (err) {
      for (const done of completedRenames.reverse()) {
        try {
          await rename(done.to, done.from)
        } catch (undoErr) {
          log.error(
            { from: done.to, to: done.from, err: undoErr },
            'could not undo a blob rename while unwinding — reconcile by hand',
          )
        }
      }
      throw err
    }
    return

    async function rewriteLegacyRows(): Promise<void> {
      for (const row of legacy) {
        const newId = generateDocumentId()
        // Insert-new / repoint-children / delete-old / claim-the-slug, in that
        // order: every step satisfies the children's foreign keys AND the
        // (workspaceId, slug) unique index on its own, so this needs no
        // deferral and holds whether or not the migration runner wrapped us in
        // a transaction. The new row borrows its own id as a slug until the
        // old row is gone — the id is unique by construction.
        await tdb
          .insertInto('canvases')
          .values({ ...row, id: newId, slug: newId })
          .execute()
        await tdb
          .updateTable('versions')
          .set({ canvasId: newId })
          .where('canvasId', '=', row.id)
          .execute()
        await tdb
          .updateTable('branches')
          .set({ canvasId: newId })
          .where('canvasId', '=', row.id)
          .execute()
        await tdb.deleteFrom('canvases').where('id', '=', row.id).execute()
        await tdb.updateTable('canvases').set({ slug: row.slug }).where('id', '=', newId).execute()

        const blobDir = join(getDataDir(), 'blobs', row.workspaceId, 'canvas')
        const from = join(blobDir, `${row.id}.loro`)
        const to = join(blobDir, `${newId}.loro`)
        try {
          await rename(from, to)
          completedRenames.push({ from, to })
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          log.warning(
            { workspaceId: row.workspaceId, oldId: row.id },
            'pre-convergence row had no blob to move',
          )
        }
      }
    }
  },
  async down(): Promise<void> {
    // The nanoid is gone and nothing can want it back.
  },
}
