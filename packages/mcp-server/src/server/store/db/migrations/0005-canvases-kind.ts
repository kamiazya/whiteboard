import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// Add canvases.kind so a canvas can carry which editor (spatial | markdown)
// opens it. Nullable because existing rows predate the field; the
// application layer maps a null kind to 'spatial' — the only kind that
// existed before this column, matching createCanvasRequestSchema's default.

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('canvases').addColumn('kind', 'text').execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('canvases').dropColumn('kind').execute()
  },
}
