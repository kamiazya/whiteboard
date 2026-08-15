import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { generateCanvasId } from '@kamiazya/whiteboard-canvas-model'
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

    for (const row of legacy) {
      const newId = generateCanvasId()
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
      try {
        await rename(join(blobDir, `${row.id}.loro`), join(blobDir, `${newId}.loro`))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        log.warning(
          { workspaceId: row.workspaceId, oldId: row.id },
          'pre-convergence row had no blob to move',
        )
      }
    }
  },
  async down(): Promise<void> {
    // The nanoid is gone and nothing can want it back.
  },
}
