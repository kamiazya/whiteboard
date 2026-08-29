import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { type Kysely, type Migration, sql } from 'kysely'
import { getDataDir } from '../../../config.js'
import { getLogger } from '../../../log.js'

// ADR-0019 splits one overloaded string into three layers. This re-keys every
// workspace this daemon already holds onto the canonical layer — a bare ULID —
// and carries the string a user actually typed into the `segment` layer, where
// segment-first resolution keeps every existing address working.
//
// Every table and column name below is a FROZEN literal, current as of 0018,
// and so are both PATTERNS: a recorded migration must not read the live schema
// or a live Zod schema, either of which is free to change out from under it.
// What "canonical" and "segment-shaped" meant at this point in the log is part
// of what this migration decided.
const CANONICAL_ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/
const SEGMENT_SHAPE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/

const TREE_KEY_PREFIX = 'workspace-tree:'

/** `docKey` tables carrying no foreign key in either direction. */
const UNCONSTRAINED_DOC_KEY_TABLES = ['documentDeltas', 'documentFrontiers'] as const

interface WorkspaceRow {
  id: string
}

/**
 * The old handle becomes the segment only when it can BE one. A nanoid-minted
 * id (`V1StGXR8_Z5jdHi6B-myT`) is outside the charset, and an id that is
 * already a ULID must not become a segment at all — a ULID-shaped segment is
 * precisely the ambiguity `workspaceSegmentSchema` exists to forbid, since
 * segment and canonical id share one position in an address.
 *
 * NULL rather than a mangled approximation: a segment nobody chose reads as
 * one somebody did.
 */
function segmentFor(oldId: string): string | null {
  if (CANONICAL_ULID.test(oldId.toUpperCase())) return null
  return SEGMENT_SHAPE.test(oldId) ? oldId : null
}

/**
 * `documentSnapshotChunks.docKey` references `documentSnapshots.docKey` with
 * `on delete cascade` and no `on update` action — measured on a fully migrated
 * database, it is the ONLY foreign key left in the schema. Neither side can be
 * updated in place: parent-first orphans the chunks, child-first points them at
 * a key that does not exist yet, and `pragma defer_foreign_keys` does not
 * rescue it (see 0013, which measured that the pragma reads back as `1` while
 * the UPDATE still fails, because it only has effect inside an explicit
 * transaction and kysely's Migrator does not open one).
 *
 * So the rewrite is a copy, then a delete that cascades the old chunks away.
 * Every statement is independently valid, which is what makes this correct
 * however the caller manages transactions.
 */
async function moveSnapshotTree(db: Kysely<unknown>, from: string, to: string): Promise<void> {
  const oldKey = `${TREE_KEY_PREFIX}${from}`
  const newKey = `${TREE_KEY_PREFIX}${to}`

  await sql`
    insert into "documentSnapshots" ("docKey", "chunkCount", "totalBytes", "maxChunkBytes", "frontier")
    select ${sql.lit(newKey)}, "chunkCount", "totalBytes", "maxChunkBytes", "frontier"
    from "documentSnapshots" where "docKey" = ${sql.lit(oldKey)}
  `.execute(db)

  await sql`
    insert into "documentSnapshotChunks" ("docKey", "chunkIndex", "bytes")
    select ${sql.lit(newKey)}, "chunkIndex", "bytes"
    from "documentSnapshotChunks" where "docKey" = ${sql.lit(oldKey)}
  `.execute(db)

  // Cascades the old chunk rows away with their parent.
  await sql`delete from "documentSnapshots" where "docKey" = ${sql.lit(oldKey)}`.execute(db)

  for (const table of UNCONSTRAINED_DOC_KEY_TABLES) {
    await sql`
      update ${sql.ref(table)} set "docKey" = ${sql.lit(newKey)}
      where "docKey" = ${sql.lit(oldKey)}
    `.execute(db)
  }
}

/**
 * The two directory trees named by a workspace: uploaded files, and version
 * thumbnails. Absent is normal — a workspace that never took an upload has no
 * `files/` — so a missing source is a no-op rather than a failure.
 */
function workspaceDirs(workspaceId: string): string[] {
  const dataDir = getDataDir()
  return [join(dataDir, workspaceId), join(dataDir, 'blobs', workspaceId)]
}

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    const tdb = db as Kysely<{ workspaces: WorkspaceRow }>
    const log = getLogger('migration-0019')

    const rows = await tdb.selectFrom('workspaces').select(['id']).execute()
    const legacy = rows.filter((row) => !CANONICAL_ULID.test(row.id))
    if (legacy.length === 0) return

    // A directory rename is the one step here a transaction cannot roll back.
    // If a LATER workspace fails, the migrator rolls the database back to the
    // old ids — and a tree already renamed onto a fresh ULID would be orphaned
    // FOREVER, because the ULID is regenerated on the next attempt and nothing
    // could find it again. So every completed rename is recorded and unwound
    // (best effort, loudly) before the error propagates: the disk then matches
    // the rolled-back database and the migration is safe to retry.
    const completed: { from: string; to: string }[] = []
    try {
      for (const { id: oldId } of legacy) {
        const newId = generateDocumentId()
        const segment = segmentFor(oldId)

        // Rows first: a renamed tree with an un-renamed row is an outage,
        // while a row that moved ahead of its files is recoverable.
        //
        // Nothing references `workspaces.id` any more (0016 dropped the last
        // foreign key onto it, 0017 dropped the table that carried it), so
        // these are plain statements in any order rather than 0008's
        // insert-new / repoint-children / delete-old dance.
        await sql`
          update "workspaces" set "id" = ${sql.lit(newId)}, "segment" = ${
            segment === null ? sql.lit(null) : sql.lit(segment)
          } where "id" = ${sql.lit(oldId)}
        `.execute(db)
        await sql`update "branches" set "workspaceId" = ${sql.lit(newId)} where "workspaceId" = ${sql.lit(oldId)}`.execute(
          db,
        )
        await sql`update "versions" set "workspaceId" = ${sql.lit(newId)} where "workspaceId" = ${sql.lit(oldId)}`.execute(
          db,
        )
        // Attribution — which workspace the operator was acting in. Matched by
        // exact equality against an id THIS daemon is re-keying, so a value
        // naming somebody else's workspace is left exactly as recorded.
        await sql`update "versions" set "operatorWorkspaceId" = ${sql.lit(newId)} where "operatorWorkspaceId" = ${sql.lit(oldId)}`.execute(
          db,
        )
        await sql`
          update "runtime" set "value" = ${sql.lit(newId)}
          where "key" = 'currentWorkspaceId' and "value" = ${sql.lit(oldId)}
        `.execute(db)

        await moveSnapshotTree(db, oldId, newId)

        for (const [i, from] of workspaceDirs(oldId).entries()) {
          const to = workspaceDirs(newId)[i] as string
          try {
            await rename(from, to)
            completed.push({ from, to })
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          }
        }

        log.info({ oldId, newId, segment }, 're-keyed workspace onto a canonical id')
      }
    } catch (err) {
      for (const done of completed.reverse()) {
        try {
          await rename(done.to, done.from)
        } catch (undoErr) {
          log.error(
            { from: done.to, to: done.from, err: undoErr },
            'could not undo a directory rename while unwinding — reconcile by hand',
          )
        }
      }
      throw err
    }
  },

  async down(): Promise<void> {
    // Not reversible: the old handles are recoverable only for the workspaces
    // whose id could BE a segment, and the ones that got NULL are gone. A
    // `down` that restored some ids and invented others would be worse than
    // none — it would report success while leaving half the daemon addressed
    // by strings nobody ever used.
    throw new Error(
      '0019-workspace-canonical-id cannot be reversed: legacy handles are not all recoverable',
    )
  },
}
