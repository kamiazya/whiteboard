import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import type { Kysely, Migration } from 'kysely'
import { getDataDir } from '../../../config.js'
import { getLogger } from '../../../log.js'

// 0008 re-minted every nanoid `documents.id` row that existed at the time it
// ran — but `upsertCanvasRow` (the version/name/branch stores' shared
// "create the row for this path if it doesn't exist yet" helper) kept
// minting FRESH nanoid ids for every path first touched by a version save, a
// display-name set, or a branch upsert, for as long as it shipped after
// 0008. Those rows are invisible to SqliteDocumentIndex.listDocuments (it
// skips a non-ULID id so one bad row cannot fail an entire listing) even
// though they are ordinary rows to the user's gallery. This migration is the
// follow-up sweep for whatever `upsertCanvasRow`'s fix (generateDocumentId)
// did not retroactively reach.
//
// Model is 0008's: insert-new / repoint-children / delete-old / claim-the-
// path, then move whatever storage was keyed on the old id — here that is
// the four `canvas:<id>` docKey tables plus, best-effort, a `.loro` blob left
// over from before the store flipped to the Libsql-backed doc store (still
// present on some data dirs as a forensic rollback aid; see
// document-store.ts). A DB with no surviving legacy blobs simply tolerates
// ENOENT on every rename.
//
// Every table/column named here is the name AS IT EXISTS AT THIS POINT IN
// THE LOG (current as of 0011) — a migration must not depend on living
// schema.ts, which can rename out from under a recorded migration key.

interface DocumentRow {
  id: string
  workspaceId: string
  path: string
  displayName: string | null
  isPinned: number
  pinOrder: number | null
  currentBranch: string
  createdAt: number
  updatedAt: number
  lastCompactedAt: number | null
  kind: string | null
}

interface DocumentSnapshotRow {
  docKey: string
  chunkCount: number
  totalBytes: number
  maxChunkBytes: number
  frontier: Uint8Array
}

interface MigrationSchema {
  documents: DocumentRow
  versions: { documentId: string }
  branches: { documentId: string }
  documentSnapshots: DocumentSnapshotRow
  documentSnapshotChunks: { docKey: string }
  documentDeltas: { docKey: string }
  documentFrontiers: { docKey: string }
}

const CANONICAL_ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

// documentSnapshotChunks.docKey carries a real FK onto documentSnapshots.docKey
// (its primary key) — SQLite has no ON UPDATE CASCADE here, so renaming the
// parent's key in place would leave the child pointing at a value that no
// longer exists and fail the FK check on the very statement that renamed it.
// insert-new/repoint-child/delete-old sidesteps that the same way the
// documents/versions/branches rewrite above does. documentDeltas and
// documentFrontiers carry no FK on docKey, so they take a plain UPDATE.

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    const tdb = db as Kysely<MigrationSchema>
    const log = getLogger('migration-0012')

    const rows = await tdb.selectFrom('documents').selectAll().execute()
    const legacy = rows.filter((row) => !CANONICAL_ULID.test(row.id))
    if (legacy.length === 0) return

    // Same non-transactional-step hazard 0008 documented: a blob rename
    // cannot be rolled back by the DB transaction, so every completed rename
    // is tracked and unwound (best effort, loudly) if a LATER row fails —
    // otherwise a retry would regenerate a fresh ULID and orphan the
    // already-renamed blob forever.
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

        await tdb
          .insertInto('documents')
          .values({ ...row, id: newId, path: newId })
          .execute()
        await tdb
          .updateTable('versions')
          .set({ documentId: newId })
          .where('documentId', '=', row.id)
          .execute()
        await tdb
          .updateTable('branches')
          .set({ documentId: newId })
          .where('documentId', '=', row.id)
          .execute()
        await tdb.deleteFrom('documents').where('id', '=', row.id).execute()
        await tdb.updateTable('documents').set({ path: row.path }).where('id', '=', newId).execute()

        const oldDocKey = `canvas:${row.id}`
        const newDocKey = `canvas:${newId}`

        const snapshot = await tdb
          .selectFrom('documentSnapshots')
          .selectAll()
          .where('docKey', '=', oldDocKey)
          .executeTakeFirst()
        if (snapshot) {
          await tdb
            .insertInto('documentSnapshots')
            // Drivers hand a BLOB column back as Buffer or a plain
            // Uint8Array depending on dialect; only Buffer is bindable on
            // the way back in, so it is re-wrapped explicitly rather than
            // spread through unchanged (a fresh copy either way — Buffer
            // over an existing Uint8Array is a view, not a clone).
            .values({ ...snapshot, docKey: newDocKey, frontier: Buffer.from(snapshot.frontier) })
            .execute()
          await tdb
            .updateTable('documentSnapshotChunks')
            .set({ docKey: newDocKey })
            .where('docKey', '=', oldDocKey)
            .execute()
          await tdb.deleteFrom('documentSnapshots').where('docKey', '=', oldDocKey).execute()
        }
        await tdb
          .updateTable('documentDeltas')
          .set({ docKey: newDocKey })
          .where('docKey', '=', oldDocKey)
          .execute()
        await tdb
          .updateTable('documentFrontiers')
          .set({ docKey: newDocKey })
          .where('docKey', '=', oldDocKey)
          .execute()

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
