/**
 * ADR-0029 retired the branch. This pins that the row goes with it — the
 * table is gone at head, and rows sitting in it at upgrade time are
 * discarded loudly rather than silently.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, type MigrationProvider, Migrator, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { beforeEach, expect, it, vi } from 'vitest'
import { migrations } from './index.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const { captureLogsForTests } = await import('../../../log.js')

const PRE_0023 = '0022-version-restored-from'

interface Handle {
  db: Kysely<Record<string, Record<string, unknown>>>
  migrateTo(name: string): Promise<void>
  migrateToHead(): Promise<void>
}

async function openDb(): Promise<Handle> {
  const db = new Kysely<Record<string, Record<string, unknown>>>({
    dialect: new SqliteDialect({
      database: new LibsqlNativeDatabase(
        join(dataDir, 'whiteboard.db'),
      ) as unknown as ConstructorParameters<typeof SqliteDialect>[0]['database'],
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

async function tableNames(db: Handle['db']): Promise<string[]> {
  const rows = await sql<{
    name: string
  }>`select name from sqlite_master where type = 'table'`.execute(db)
  return rows.rows.map((r) => r.name)
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'drop-branches-'))
})

it('drops the branches table, discarding the rows loudly', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0023)

  // The table exists before the drop — a probe, so "gone at head" cannot be
  // satisfied by a table that was never there.
  expect(await tableNames(handle.db)).toContain('branches')
  await handle.db
    .insertInto('branches')
    .values({
      workspaceId: 'ws-1',
      documentId: 'doc-1',
      name: 'old-work',
      color: '#4f46e5',
      tipFrontiers: '',
      createdAt: Date.now(),
    })
    .execute()

  const logs = captureLogsForTests('warning')
  try {
    await handle.migrateToHead()
    expect(await tableNames(handle.db)).not.toContain('branches')
    // Discarding a row is a thing a person can be told about; a silent drop
    // is how a workspace loses something nobody knew it had.
    expect(logs.records.map((r) => r.msg)).toContainEqual(
      expect.stringContaining('1 branch rows discarded'),
    )
  } finally {
    logs.restore()
  }
})

it('drops a branchless table without warning', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0023)

  const logs = captureLogsForTests('warning')
  try {
    await handle.migrateToHead()
    expect(await tableNames(handle.db)).not.toContain('branches')
    expect(logs.records.filter((r) => r.msg.includes('branch rows discarded'))).toEqual([])
  } finally {
    logs.restore()
  }
})
