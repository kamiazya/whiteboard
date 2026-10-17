/**
 * ADR-0053: a workspace segment is unique within its namespace, and a tenant's
 * user holds a handle that names theirs. Pins the backfill (every user a
 * handle unique in their tenant; every workspace the namespace of its
 * earliest surviving owner, or the single-person `me` when it has no member
 * at all), the refusal for a workspace with members but no owner, and that the
 * new index admits one segment in two namespaces and in two tenants.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openMigrationHarness } from '../test-helpers.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const PRE_0046 = '0044-sign-in-attempt-source'

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-0046-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

const profile = (id: string, displayName: string, createdAt: number, tenantId = 'self-host') => ({
  id,
  displayName,
  accountId: `account-${id}`,
  createdAt,
  updatedAt: createdAt,
  tenantId,
})

const workspace = (id: string, segment: string | null, tenantId = 'self-host') => ({
  id,
  segment,
  displayName: null,
  createdAt: 1,
  updatedAt: 1,
  tenantId,
})

it('gives every user a handle unique in their tenant, in the order they joined', async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateTo(PRE_0046)
  await db
    .insertInto('memberProfiles')
    .values([
      profile('p-ada2', 'Ada Lovelace', 20),
      profile('p-ada1', 'Ada Lovelace', 10),
      profile('p-me', 'Me', 30),
      profile('p-ada-t2', 'Ada Lovelace', 40, 'tenant-two'),
    ])
    .execute()

  await migrateToHead()

  const rows = await db
    .selectFrom('memberProfiles')
    .select(['id', 'handle'])
    .orderBy('id')
    .execute()
  expect(rows).toEqual([
    { id: 'p-ada-t2', handle: 'ada-lovelace' },
    { id: 'p-ada1', handle: 'ada-lovelace' },
    { id: 'p-ada2', handle: 'ada-lovelace-2' },
    { id: 'p-me', handle: 'user' },
  ])
  await db.destroy()
})

it("puts each workspace in its earliest owner's namespace, and a memberless one in `me`", async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateTo(PRE_0046)
  await db
    .insertInto('memberProfiles')
    .values([profile('p-ada', 'Ada', 1), profile('p-bob', 'Bob', 2)])
    .execute()
  await db
    .insertInto('workspaces')
    .values([workspace('ws-shared', 'design'), workspace('ws-alone', 'notes')])
    .execute()
  await db
    .insertInto('workspaceMemberships')
    .values([
      // Bob joined first but as a member; the earliest OWNER holds it.
      { workspaceId: 'ws-shared', profileId: 'p-bob', createdAt: 5, role: 'member' },
      { workspaceId: 'ws-shared', profileId: 'p-ada', createdAt: 10, role: 'owner' },
    ])
    .execute()

  await migrateToHead()

  const rows = await db.selectFrom('workspaces').select(['id', 'namespace']).orderBy('id').execute()
  expect(rows).toEqual([
    { id: 'ws-alone', namespace: 'me' },
    { id: 'ws-shared', namespace: 'ada' },
  ])
  await db.destroy()
})

it('breaks an owner tie by user id', async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateTo(PRE_0046)
  await db
    .insertInto('memberProfiles')
    .values([profile('p-b', 'Bea', 1), profile('p-a', 'Al', 2)])
    .execute()
  await db.insertInto('workspaces').values(workspace('ws', 'design')).execute()
  await db
    .insertInto('workspaceMemberships')
    .values([
      { workspaceId: 'ws', profileId: 'p-b', createdAt: 5, role: 'owner' },
      { workspaceId: 'ws', profileId: 'p-a', createdAt: 5, role: 'owner' },
    ])
    .execute()

  await migrateToHead()

  const row = await db.selectFrom('workspaces').select('namespace').executeTakeFirstOrThrow()
  expect(row).toEqual({ namespace: 'al' })
  await db.destroy()
})

it('refuses a workspace that has members but no owner, rather than guessing one', async () => {
  const { db, migrateTo, migrateToHeadRaw } = await openMigrationHarness(dataDir)
  await migrateTo(PRE_0046)
  await db
    .insertInto('memberProfiles')
    .values(profile('p-ada', 'Ada', 1))
    .execute()
  await db.insertInto('workspaces').values(workspace('ws-ownerless', 'design')).execute()
  await db
    .insertInto('workspaceMemberships')
    .values({ workspaceId: 'ws-ownerless', profileId: 'p-ada', createdAt: 5, role: 'member' })
    .execute()

  const error = await migrateToHeadRaw()

  expect(String(error)).toMatch(/ws-ownerless/)
  expect(String(error)).toMatch(/role 'owner'/)
  await db.destroy()
})

it('admits one segment in two namespaces and in two tenants, but not twice in one namespace', async () => {
  const { db, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateToHead()
  await db
    .insertInto('workspaces')
    .values([
      { ...workspace('ws-ada', 'design'), namespace: 'ada' },
      { ...workspace('ws-bob', 'design'), namespace: 'bob' },
      { ...workspace('ws-t2', 'design', 'tenant-two'), namespace: 'ada' },
    ])
    .execute()

  await expect(
    db
      .insertInto('workspaces')
      .values({ ...workspace('ws-ada-again', 'design'), namespace: 'ada' })
      .execute(),
  ).rejects.toThrow(/UNIQUE/)
  await db.destroy()
})

it('holds a handle unique per tenant', async () => {
  const { db, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateToHead()
  await db
    .insertInto('memberProfiles')
    .values([
      { ...profile('p-1', 'Ada', 1), handle: 'ada' },
      { ...profile('p-2', 'Ada', 1, 'tenant-two'), handle: 'ada' },
    ])
    .execute()

  await expect(
    db
      .insertInto('memberProfiles')
      .values({ ...profile('p-3', 'Ada', 1), handle: 'ada' })
      .execute(),
  ).rejects.toThrow(/UNIQUE/)
  await db.destroy()
})

it('down restores the keeper-wide segment index and drops both columns', async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateToHead()
  await db.insertInto('workspaces').values(workspace('ws-a', 'design')).execute()

  await migrateTo(PRE_0046)

  const columns = async (table: string) =>
    (
      await sql<{ name: string }>`select name from pragma_table_info(${table})`.execute(db)
    ).rows.map((c) => c.name)
  expect(await columns('workspaces')).not.toContain('namespace')
  expect(await columns('memberProfiles')).not.toContain('handle')
  await expect(
    db.insertInto('workspaces').values(workspace('ws-b', 'design')).execute(),
  ).rejects.toThrow(/UNIQUE/)
  await db.destroy()
})
