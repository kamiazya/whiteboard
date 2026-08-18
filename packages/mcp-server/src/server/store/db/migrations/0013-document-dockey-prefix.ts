import { type Kysely, type Migration, sql } from 'kysely'

// ADR-0009 calls the container a Document, and `docRefKey` now spells its
// `docKey` accordingly. The prefix stopped being an in-memory map key when the
// byte store moved into the database, so correcting it means rewriting a
// stored column rather than renaming an identifier.
//
// Every table and column name below is a FROZEN literal, current as of 0012 —
// a recorded migration must not read the live schema, which is free to change
// out from under it.
//
// `workspace-tree:<workspaceId>` keys are deliberately untouched: only the
// document arm of `docRefKey` carried the retired noun.

const OLD_PREFIX = 'canvas:'
const NEW_PREFIX = 'document:'

/** Tables whose `docKey` carries no foreign key in either direction. */
const UNCONSTRAINED_TABLES = ['documentDeltas', 'documentFrontiers'] as const

/**
 * `documentSnapshotChunks.docKey` references `documentSnapshots.docKey` with
 * `on delete cascade` and no `on update` action, so neither side can be
 * updated in place: parent-first orphans the chunks, child-first points them
 * at a key that does not exist yet.
 *
 * `pragma defer_foreign_keys` does NOT rescue this, and why is worth
 * recording — it reads back as `1` and the UPDATE still fails. The pragma
 * only has effect inside an explicit transaction, and kysely's Migrator does
 * not open one here, so each statement commits on its own and takes the
 * constraint check with it. Measured: the error surfaces at the UPDATE
 * itself, not at a commit.
 *
 * So the rewrite is a copy, then a delete that cascades the old chunks away.
 * Every statement is independently valid, which is what makes this correct
 * however the caller manages transactions.
 */
async function rewriteSnapshotPrefix(db: Kysely<unknown>, from: string, to: string): Promise<void> {
  const renamed = sql`${sql.lit(to)} || substr("docKey", ${sql.lit(from.length + 1)})`
  const matches = sql`"docKey" like ${sql.lit(`${from}%`)}`

  await sql`
    insert into "documentSnapshots" ("docKey", "chunkCount", "totalBytes", "maxChunkBytes", "frontier")
    select ${renamed}, "chunkCount", "totalBytes", "maxChunkBytes", "frontier"
    from "documentSnapshots" where ${matches}
  `.execute(db)

  await sql`
    insert into "documentSnapshotChunks" ("docKey", "chunkIndex", "bytes")
    select ${renamed}, "chunkIndex", "bytes"
    from "documentSnapshotChunks" where ${matches}
  `.execute(db)

  // Cascades the old chunk rows away with their parent.
  await sql`delete from "documentSnapshots" where ${matches}`.execute(db)
}

async function rewriteUnconstrainedPrefix(
  db: Kysely<unknown>,
  from: string,
  to: string,
): Promise<void> {
  for (const table of UNCONSTRAINED_TABLES) {
    // Anchored on purpose. A documentId is a ULID, so `canvas:` can only occur
    // as the prefix today — but a blanket REPLACE would also rewrite the word
    // anywhere inside a future key, and `substr` past a matched prefix cannot.
    // Rows already on the target prefix match nothing, which is what makes a
    // re-run a no-op.
    await sql`
      update ${sql.ref(table)}
      set "docKey" = ${sql.lit(to)} || substr("docKey", ${sql.lit(from.length + 1)})
      where "docKey" like ${sql.lit(`${from}%`)}
    `.execute(db)
  }
}

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await rewriteSnapshotPrefix(db, OLD_PREFIX, NEW_PREFIX)
    await rewriteUnconstrainedPrefix(db, OLD_PREFIX, NEW_PREFIX)
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await rewriteSnapshotPrefix(db, NEW_PREFIX, OLD_PREFIX)
    await rewriteUnconstrainedPrefix(db, NEW_PREFIX, OLD_PREFIX)
  },
}
