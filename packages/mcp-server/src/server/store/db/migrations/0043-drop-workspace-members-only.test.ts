/**
 * The members-only marker goes with its last reader. Pins that the table is
 * gone at head with the memberships it was derived from intact, and that
 * `down` rebuilds it from those memberships in the shape 0031 left it.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Kysely, sql } from 'kysely'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openMigrationHarness } from '../test-helpers.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const PRE_0043 = '0042-sign-in-attempt-invitation-hash'

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-0043-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

type Db = Kysely<Record<string, Record<string, unknown>>>

async function tableNames(db: Db) {
  const rows = await sql<{ name: string }>`
    select name from sqlite_master where type = 'table'
  `.execute(db)
  return rows.rows.map((r) => r.name)
}

it('drops workspaceMembersOnly and keeps every membership row', async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateTo(PRE_0043)
  await db
    .insertInto('memberProfiles')
    .values({ id: 'p1', displayName: 'Ada', accountId: 'a1', createdAt: 1, updatedAt: 1 })
    .execute()
  await db
    .insertInto('workspaceMemberships')
    .values({ workspaceId: 'ws-a', profileId: 'p1', createdAt: 10, role: 'owner' })
    .execute()
  expect(await tableNames(db)).toContain('workspaceMembersOnly')

  await migrateToHead()

  expect(await tableNames(db)).not.toContain('workspaceMembersOnly')
  const memberships = await db
    .selectFrom('workspaceMemberships')
    .select(['workspaceId', 'profileId'])
    .execute()
  expect(memberships).toEqual([{ workspaceId: 'ws-a', profileId: 'p1' }])
  await db.destroy()
})

it('down rebuilds the marker from the memberships still present', async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateToHead()
  await db
    .insertInto('memberProfiles')
    .values({ id: 'p1', displayName: 'Ada', accountId: 'a1', createdAt: 1, updatedAt: 1 })
    .execute()
  await db
    .insertInto('workspaceMemberships')
    .values([
      { workspaceId: 'ws-a', profileId: 'p1', createdAt: 20, role: 'owner' },
      { workspaceId: 'ws-b', profileId: 'p1', createdAt: 30, role: 'owner' },
    ])
    .execute()

  await migrateTo(PRE_0043)

  const rows = await db
    .selectFrom('workspaceMembersOnly')
    .select(['workspaceId', 'since', 'tenantId'])
    .orderBy('workspaceId', 'asc')
    .execute()
  expect(rows).toEqual([
    { workspaceId: 'ws-a', since: 20, tenantId: 'self-host' },
    { workspaceId: 'ws-b', since: 30, tenantId: 'self-host' },
  ])
  await db.destroy()
})
