import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, type MigrationProvider, Migrator, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './index.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const PRE_0016 = '0015-versions-branches-workspace-id'
const DOC_A = '01JQZ0000000000000000000A0'

interface Handle {
  db: Kysely<Record<string, Record<string, unknown>>>
  migrateTo(name: string): Promise<void>
  migrateToHead(): Promise<void>
}

async function openDb(): Promise<Handle> {
  const dbPath = join(dataDir, 'whiteboard.db')
  const db = new Kysely<Record<string, Record<string, unknown>>>({
    dialect: new SqliteDialect({
      database: new LibsqlNativeDatabase(dbPath) as unknown as ConstructorParameters<
        typeof SqliteDialect
      >[0]['database'],
    }),
  })
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  const provider: MigrationProvider = { getMigrations: async () => migrations }
  const migrator = new Migrator({ db: db as never, provider })
  return {
    db,
    async migrateTo(name: string) {
      const { error } = await migrator.migrateTo(name)
      expect(error).toBeUndefined()
    },
    async migrateToHead() {
      const { error } = await migrator.migrateToLatest()
      expect(error).toBeUndefined()
    },
  }
}

async function seedDocument(db: Handle['db']): Promise<void> {
  const now = Date.now()
  await db
    .insertInto('workspaces')
    .values({ id: 'ws-1', displayName: null, createdAt: now, updatedAt: now })
    .execute()
  await db
    .insertInto('documents')
    .values({
      id: DOC_A,
      workspaceId: 'ws-1',
      path: 'a',
      displayName: null,
      isPinned: 0,
      pinOrder: null,
      currentBranch: 'main',
      createdAt: now,
      updatedAt: now,
      kind: 'spatial',
    })
    .execute()
}

async function seedVersionAndBranch(db: Handle['db']): Promise<void> {
  await db
    .insertInto('versions')
    .values({
      id: 'v-a',
      documentId: DOC_A,
      workspaceId: 'ws-1',
      branchName: 'main',
      auto: 1,
      label: null,
      operatorKind: 'system',
      operatorPeerId: '',
      operatorDisplayName: null,
      operatorAgentId: null,
      operatorWorkspaceId: null,
      elementCount: 0,
      frontiers: 'AAECAw==',
      hasThumbnail: 0,
      createdAt: Date.now(),
    })
    .execute()
  await db
    .insertInto('branches')
    .values({
      documentId: DOC_A,
      workspaceId: 'ws-1',
      name: 'main',
      tipFrontiers: '',
      color: null,
      sourceBranchName: null,
      sourceVersionId: null,
      createdAt: Date.now(),
    })
    .execute()
}

describe('0016-drop-documents-fk', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'migration-0016-'))
  })

  // The documents table stops being the address book (dual-plane collapse
  // S7): a version/branch row must outlive its mirror row, because after
  // the wrapper retirement a document created through the tree has no row
  // at all. Delete-completeness moves from the FK cascade into the delete
  // path's own explicit cleanup.
  it('version and branch rows survive without any documents row', async () => {
    const handle = await openDb()
    await handle.migrateToHead()
    const now = Date.now()
    await handle.db
      .insertInto('workspaces')
      .values({ id: 'ws-1', displayName: null, createdAt: now, updatedAt: now })
      .execute()

    // No documents row at all — the insert must succeed post-0016.
    await seedVersionAndBranch(handle.db)

    const versions = await handle.db.selectFrom('versions').select(['id']).execute()
    expect(versions).toEqual([{ id: 'v-a' }])
  })

  it('carries existing version/branch rows across the rebuild', async () => {
    const handle = await openDb()
    await handle.migrateTo(PRE_0016)
    await seedDocument(handle.db)
    await seedVersionAndBranch(handle.db)

    // This is 0016's own migration test: migrate to exactly the stage it
    // introduces, not head — 0017 (a later, unrelated migration) drops the
    // documents table this test still deletes a row from below.
    await handle.migrateTo('0016-drop-documents-fk')

    expect(await handle.db.selectFrom('versions').select(['id', 'workspaceId']).execute()).toEqual([
      { id: 'v-a', workspaceId: 'ws-1' },
    ])
    expect(
      await handle.db.selectFrom('branches').select(['name', 'workspaceId']).execute(),
    ).toEqual([{ name: 'main', workspaceId: 'ws-1' }])

    // And a documents delete no longer cascades: cleanup is the delete
    // path's job now, so the rows must still be there.
    await handle.db.deleteFrom('documents').where('id', '=', DOC_A).execute()
    expect((await handle.db.selectFrom('versions').select(['id']).execute()).length).toBe(1)
    expect((await handle.db.selectFrom('branches').select(['name']).execute()).length).toBe(1)
  })
})
