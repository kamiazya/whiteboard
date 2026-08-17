import type { Kysely, Migration } from 'kysely'

// `slug` is the document's PATH — `validateSlug` splits it on `/` and checks
// each segment, and the value it holds is what `DocumentIndex` has always
// called `path` (`documentPathSchema`, `DocumentPathTakenError`, "ordered by
// path, compared segment by segment"). The rule was already shared —
// `SAFE_SLUG_SEGMENT` IS `DOCUMENT_PATH_SEGMENT_PATTERN` — so only the name
// was still crossing layers and changing on the way.
//
// The `(workspaceId, slug)` unique constraint follows the column rename
// automatically; its NAME (`canvases_ws_slug_unq`) does not, and stays for
// the same reason 0009 left constraint names alone — SQLite cannot rename one
// without rebuilding the table, and it appears nowhere outside
// `sqlite_master`.
//
// Every name below is the name AS IT EXISTS AT THIS POINT IN THE LOG: 0009
// has already renamed `canvases` to `documents`. A migration is history, so
// both sides of this rename are literals that must never move again.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('documents').renameColumn('slug', 'path').execute()
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('documents').renameColumn('path', 'slug').execute()
  },
}
