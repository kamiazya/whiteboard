import type { Kysely, Migration } from 'kysely'

// Add canvases.lastCompactedAt so the auto-Optimize loop has a per-canvas
// "do not run again until something has changed" signal, and so the UI can
// surface "Auto-optimised Ns ago". Nullable because existing rows have no
// recorded compaction history; the auto-compact code treats null as
// "never compacted" and proceeds normally.

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('canvases')
      .addColumn('lastCompactedAt', 'integer')
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('canvases').dropColumn('lastCompactedAt').execute()
  },
}
