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

// The last migration a database that predates 0015 had applied. Seeding at
// this point exercises the real upgrade path rather than a hand-built table.
const PRE_0015 = '0014-versions-workspace-scoped'

const DOC_A = '01JQZ0000000000000000000A0'
const DOC_B = '01JQZ0000000000000000000B0'

interface Handle {
  db: Kysely<Record<string, Record<string, unknown>>>
  migrateToPre0015(): Promise<void>
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
    async migrateToPre0015() {
      const { error } = await migrator.migrateTo(PRE_0015)
      expect(error).toBeUndefined()
    },
    async migrateToHead() {
      const { error } = await migrator.migrateToLatest()
      expect(error).toBeUndefined()
    },
  }
}

async function seedWorkspaceWithDocuments(db: Handle['db']): Promise<void> {
  const now = Date.now()
  for (const ws of ['ws-1', 'ws-2']) {
    await db
      .insertInto('workspaces')
      .values({ id: ws, displayName: null, createdAt: now, updatedAt: now })
      .execute()
  }
  for (const [ws, id, path] of [
    ['ws-1', DOC_A, 'a'],
    ['ws-2', DOC_B, 'b'],
  ] as const) {
    await db
      .insertInto('documents')
      .values({
        id,
        workspaceId: ws,
        path,
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
}

async function seedVersionRow(
  db: Handle['db'],
  id: string,
  documentId: string,
  workspaceScoped = 1,
): Promise<void> {
  await db
    .insertInto('versions')
    .values({
      id,
      documentId,
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
      workspaceScoped,
    })
    .execute()
}

async function seedBranchRow(db: Handle['db'], documentId: string, name: string): Promise<void> {
  await db
    .insertInto('branches')
    .values({
      documentId,
      name,
      tipFrontiers: '',
      color: null,
      sourceBranchName: null,
      sourceVersionId: null,
      createdAt: Date.now(),
    })
    .execute()
}

describe('0015-versions-branches-workspace-id', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'migration-0015-'))
  })

  it('backfills workspaceId on versions and branches from the documents join, and drops workspaceScoped', async () => {
    const handle = await openDb()
    await handle.migrateToPre0015()
    await seedWorkspaceWithDocuments(handle.db)
    await seedVersionRow(handle.db, 'v-a', DOC_A)
    await seedVersionRow(handle.db, 'v-b', DOC_B)
    await seedBranchRow(handle.db, DOC_A, 'main')
    await seedBranchRow(handle.db, DOC_B, 'feature')

    await handle.migrateToHead()

    const versions = await handle.db
      .selectFrom('versions')
      .select(['id', 'workspaceId'])
      .orderBy('id')
      .execute()
    expect(versions).toEqual([
      { id: 'v-a', workspaceId: 'ws-1' },
      { id: 'v-b', workspaceId: 'ws-2' },
    ])

    const branches = await handle.db
      .selectFrom('branches')
      .select(['documentId', 'workspaceId'])
      .orderBy('documentId')
      .execute()
    expect(branches).toEqual([
      { documentId: DOC_A, workspaceId: 'ws-1' },
      { documentId: DOC_B, workspaceId: 'ws-2' },
    ])

    // The always-1 scope flag is gone with the legacy plane it described.
    const columns = await sql<{
      name: string
    }>`select name from pragma_table_info('versions')`.execute(handle.db)
    expect(columns.rows.map((r) => r.name)).not.toContain('workspaceScoped')
  })

  it('deletes legacy per-document-scoped version rows before dropping the flag', async () => {
    // The boot fold used to sweep workspaceScoped=0 rows per record; with the
    // flag dropped nothing could identify them afterwards, so the migration
    // performs the sweep once and finally.
    const handle = await openDb()
    await handle.migrateToPre0015()
    await seedWorkspaceWithDocuments(handle.db)
    await seedVersionRow(handle.db, 'v-scoped', DOC_A)
    await seedVersionRow(handle.db, 'v-legacy', DOC_A, 0)

    await handle.migrateToHead()

    const ids = (await handle.db.selectFrom('versions').select(['id']).execute()).map((r) => r.id)
    expect(ids).toEqual(['v-scoped'])
  })

  it('keeps the ON DELETE CASCADE from documents to versions and branches', async () => {
    // The re-key adds a column; it must not rebuild the tables in a way that
    // silently drops migration 0001's cascade — the delete-completeness the
    // document delete path relies on.
    const handle = await openDb()
    await handle.migrateToPre0015()
    await seedWorkspaceWithDocuments(handle.db)
    await seedVersionRow(handle.db, 'v-a', DOC_A)
    await seedBranchRow(handle.db, DOC_A, 'main')
    await handle.migrateToHead()

    await handle.db.deleteFrom('documents').where('id', '=', DOC_A).execute()

    expect(await handle.db.selectFrom('versions').selectAll().execute()).toEqual([])
    expect(await handle.db.selectFrom('branches').selectAll().execute()).toEqual([])
  })
})
