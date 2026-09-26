/**
 * ADR-0049 decision 1: each existing workspace's earliest membership becomes
 * its owner and the rest become members, which is what the store does for a
 * workspace's first member from here on. Mirrors 0032-accounts.test.ts.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, SqliteDialect, sql } from 'kysely'
import { type MigrationProvider, Migrator } from 'kysely/migration'
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

const PRE_0036 = '0035-sign-in-attempts'

type Db = Kysely<Record<string, Record<string, unknown>>>

async function openDb(): Promise<{ db: Db; migrateTo(name: string): Promise<void> }> {
  const db: Db = new Kysely({
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
      const { error } =
        name === 'head' ? await migrator.migrateToLatest() : await migrator.migrateTo(name)
      expect(error).toBeUndefined()
    },
  }
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-0036-'))
})

it("makes each workspace's earliest member its owner, per tenant", async () => {
  const { db, migrateTo } = await openDb()
  await migrateTo(PRE_0036)
  await db
    .insertInto('workspaceMemberships')
    .values([
      { workspaceId: 'ws-1', profileId: 'p-bob', createdAt: 20, tenantId: 't1' },
      { workspaceId: 'ws-1', profileId: 'p-ada', createdAt: 10, tenantId: 't1' },
      { workspaceId: 'ws-2', profileId: 'p-bob', createdAt: 5, tenantId: 't1' },
      { workspaceId: 'ws-1', profileId: 'p-cy', createdAt: 30, tenantId: 't2' },
    ])
    .execute()
  await migrateTo('head')
  const rows = await db
    .selectFrom('workspaceMemberships')
    .select(['tenantId', 'workspaceId', 'profileId', 'role'])
    .orderBy('tenantId')
    .orderBy('workspaceId')
    .orderBy('profileId')
    .execute()
  expect(rows).toEqual([
    { tenantId: 't1', workspaceId: 'ws-1', profileId: 'p-ada', role: 'owner' },
    { tenantId: 't1', workspaceId: 'ws-1', profileId: 'p-bob', role: 'member' },
    { tenantId: 't1', workspaceId: 'ws-2', profileId: 'p-bob', role: 'owner' },
    { tenantId: 't2', workspaceId: 'ws-1', profileId: 'p-cy', role: 'owner' },
  ])
  await db.destroy()
})

// createdAt is milliseconds, so two memberships can share it; the store makes
// exactly one owner per workspace, and so must the backfill.
it('makes exactly one owner when the earliest memberships share a timestamp', async () => {
  const { db, migrateTo } = await openDb()
  await migrateTo(PRE_0036)
  await db
    .insertInto('workspaceMemberships')
    .values([
      { workspaceId: 'ws-1', profileId: 'p-bob', createdAt: 10, tenantId: 't1' },
      { workspaceId: 'ws-1', profileId: 'p-ada', createdAt: 10, tenantId: 't1' },
    ])
    .execute()
  await migrateTo('head')
  const rows = await db
    .selectFrom('workspaceMemberships')
    .select(['profileId', 'role'])
    .orderBy('profileId')
    .execute()
  expect(rows).toEqual([
    { profileId: 'p-ada', role: 'owner' },
    { profileId: 'p-bob', role: 'member' },
  ])
  await db.destroy()
})
