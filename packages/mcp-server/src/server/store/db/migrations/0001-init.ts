import type { Kysely, Migration } from 'kysely'
import { sql } from 'kysely'

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('workspaces')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('displayName', 'text')
      .addColumn('createdAt', 'integer', (c) => c.notNull())
      .addColumn('updatedAt', 'integer', (c) => c.notNull())
      .execute()

    await db.schema
      .createTable('canvases')
      .addColumn('workspaceId', 'text', (c) =>
        c.notNull().references('workspaces.id').onDelete('cascade'),
      )
      .addColumn('slug', 'text', (c) => c.notNull())
      .addColumn('displayName', 'text')
      .addColumn('isPinned', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('pinOrder', 'integer')
      .addColumn('currentBranch', 'text', (c) => c.notNull().defaultTo('main'))
      .addColumn('createdAt', 'integer', (c) => c.notNull())
      .addColumn('updatedAt', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('canvases_pk', ['workspaceId', 'slug'])
      .execute()

    await db.schema
      .createIndex('canvases_workspace_updated_idx')
      .on('canvases')
      .columns(['workspaceId', 'updatedAt'])
      .execute()

    await db.schema
      .createTable('branches')
      .addColumn('workspaceId', 'text', (c) => c.notNull())
      .addColumn('slug', 'text', (c) => c.notNull())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('tipFrontiers', 'text', (c) => c.notNull())
      .addColumn('color', 'text')
      .addColumn('sourceBranchName', 'text')
      .addColumn('sourceVersionId', 'text')
      .addColumn('createdAt', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('branches_pk', ['workspaceId', 'slug', 'name'])
      .addForeignKeyConstraint(
        'branches_canvas_fk',
        ['workspaceId', 'slug'],
        'canvases',
        ['workspaceId', 'slug'],
      )
      .execute()

    await db.schema
      .createTable('versions')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('workspaceId', 'text', (c) => c.notNull())
      .addColumn('slug', 'text', (c) => c.notNull())
      .addColumn('branchName', 'text', (c) => c.notNull().defaultTo('main'))
      .addColumn('auto', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('label', 'text')
      .addColumn('operatorKind', 'text', (c) => c.notNull())
      .addColumn('operatorPeerId', 'text', (c) => c.notNull())
      .addColumn('operatorDisplayName', 'text')
      .addColumn('operatorAgentId', 'text')
      .addColumn('operatorWorkspaceId', 'text')
      .addColumn('sizeBytes', 'integer', (c) => c.notNull())
      .addColumn('frontiers', 'text', (c) => c.notNull())
      .addColumn('hasThumbnail', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('createdAt', 'integer', (c) => c.notNull())
      .addForeignKeyConstraint(
        'versions_canvas_fk',
        ['workspaceId', 'slug'],
        'canvases',
        ['workspaceId', 'slug'],
      )
      .execute()

    await db.schema
      .createIndex('versions_canvas_branch_idx')
      .on('versions')
      .columns(['workspaceId', 'slug', 'branchName', 'createdAt'])
      .execute()

    await db.schema
      .createTable('palette')
      .addColumn('workspaceId', 'text', (c) =>
        c.notNull().references('workspaces.id').onDelete('cascade'),
      )
      .addColumn('key', 'text', (c) => c.notNull())
      .addColumn('value', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('palette_pk', ['workspaceId', 'key'])
      .execute()

    await db.schema
      .createTable('installed_libraries')
      .addColumn('workspaceId', 'text', (c) =>
        c.notNull().references('workspaces.id').onDelete('cascade'),
      )
      .addColumn('url', 'text', (c) => c.notNull())
      .addColumn('installedAt', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('installed_libraries_pk', ['workspaceId', 'url'])
      .execute()

    await db.schema
      .createTable('user_libraries')
      .addColumn('name', 'text', (c) => c.primaryKey())
      .addColumn('itemCount', 'integer')
      .addColumn('createdAt', 'integer', (c) => c.notNull())
      .addColumn('updatedAt', 'integer', (c) => c.notNull())
      .execute()

    await db.schema
      .createTable('user_library_metadata')
      .addColumn('name', 'text', (c) =>
        c.primaryKey().references('user_libraries.name').onDelete('cascade'),
      )
      .addColumn('manifestJson', 'text', (c) => c.notNull())
      .addColumn('updatedAt', 'integer', (c) => c.notNull())
      .execute()

    await db.schema
      .createTable('runtime')
      .addColumn('key', 'text', (c) => c.primaryKey())
      .addColumn('value', 'text')
      .addColumn('updatedAt', 'integer', (c) => c.notNull())
      .execute()

    await db.schema
      .createTable('quarantine_log')
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('scope', 'text', (c) => c.notNull())
      .addColumn('key', 'text', (c) => c.notNull())
      .addColumn('bucketPath', 'text', (c) => c.notNull())
      .addColumn('createdAt', 'integer', (c) => c.notNull())
      .execute()

    // Defensive: SQLite does not enforce FK by default. Future migrations may
    // rely on cascading deletes; turning the pragma on per-connection happens
    // in db/index.ts, but make the dependency explicit at schema time by
    // touching sqlite_master here so a missing pragma is loud, not silent.
    await sql`PRAGMA foreign_keys = ON`.execute(db)
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('quarantine_log').execute()
    await db.schema.dropTable('runtime').execute()
    await db.schema.dropTable('user_library_metadata').execute()
    await db.schema.dropTable('user_libraries').execute()
    await db.schema.dropTable('installed_libraries').execute()
    await db.schema.dropTable('palette').execute()
    await db.schema.dropTable('versions').execute()
    await db.schema.dropTable('branches').execute()
    await db.schema.dropTable('canvases').execute()
    await db.schema.dropTable('workspaces').execute()
  },
}
