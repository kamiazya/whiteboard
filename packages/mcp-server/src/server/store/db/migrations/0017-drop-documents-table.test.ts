import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, type MigrationProvider, Migrator, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../../../log.js'
import { migrations } from './index.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const PRE_0017 = '0016-drop-documents-fk'

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

async function seedWorkspace(db: Handle['db']): Promise<void> {
  const now = Date.now()
  await db
    .insertInto('workspaces')
    .values({ id: 'ws-1', displayName: null, createdAt: now, updatedAt: now })
    .execute()
}

async function seedDocumentRow(db: Handle['db'], id: string): Promise<void> {
  const now = Date.now()
  await db
    .insertInto('documents')
    .values({
      id,
      workspaceId: 'ws-1',
      path: id,
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

async function tableExists(db: Handle['db'], name: string): Promise<boolean> {
  const row = await db
    .selectFrom('sqlite_master' as never)
    .select(['name' as never])
    .where('type', '=', 'table')
    .where('name', '=', name)
    .executeTakeFirst()
  return row !== undefined
}

describe('0017-drop-documents-table', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'migration-0017-'))
  })

  it('drops the documents table and warns naming the discarded row count when rows remain', async () => {
    const handle = await openDb()
    await handle.migrateTo(PRE_0017)
    await seedWorkspace(handle.db)
    await seedDocumentRow(handle.db, 'doc-a')
    await seedDocumentRow(handle.db, 'doc-b')

    const capture = captureLogsForTests()
    try {
      await handle.migrateToHead()
      const warnings = capture.records.filter((r) => r.level === 'warning')
      expect(
        warnings.some(
          (r) =>
            typeof r.msg === 'string' &&
            r.msg.includes('2') &&
            r.msg.toLowerCase().includes('discarded'),
        ),
      ).toBe(true)
    } finally {
      capture.restore()
    }

    expect(await tableExists(handle.db, 'documents')).toBe(false)
  })

  it('drops the documents table with no warning when the inbox is empty', async () => {
    const handle = await openDb()
    await handle.migrateTo(PRE_0017)
    await seedWorkspace(handle.db)

    const capture = captureLogsForTests()
    try {
      await handle.migrateToHead()
      const warnings = capture.records.filter((r) => r.level === 'warning')
      expect(warnings).toEqual([])
    } finally {
      capture.restore()
    }

    expect(await tableExists(handle.db, 'documents')).toBe(false)
  })
})
