/**
 * The email invitation's column, check constraint and index go; the link
 * invitations a keeper already holds survive the table rebuild unchanged.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { beforeEach, expect, it, vi } from 'vitest'
import { openMigrationHarness } from '../test-helpers.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const PRE_0040 = '0039-sign-in-authenticated-at'

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-0040-'))
})

it('removes the email column and its index, keeping the tenant index', async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateTo(PRE_0040)
  await migrateToHead()
  const columns = await sql<{ name: string }>`
    select name from pragma_table_info('invitations')
  `.execute(db)
  expect(columns.rows.map((r) => r.name)).not.toContain('email')
  const indexes = await sql<{ name: string }>`
    select name from pragma_index_list('invitations')
  `.execute(db)
  const names = indexes.rows.map((r) => r.name)
  expect(names).not.toContain('invitations_email')
  expect(names).toContain('invitations_tenantId')
  await db.destroy()
})

it('carries link invitations across the rebuild and drops email-only rows', async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateTo(PRE_0040)
  await sql`
    insert into invitations
      (id, tokenHash, email, invitedBy, createdAt, expiresAt, redeemedAt, redeemedBy, tenantId, workspaceId)
    values
      ('i-link', 'hash-1', null, 'p-ada', 10, 20, 15, 'p-bob', 't1', 'ws-1'),
      ('i-open', 'hash-2', null, 'p-ada', 11, 21, null, null, 't2', null),
      ('i-mail', null, 'a@example.com', 'p-ada', 12, 22, null, null, 't1', null)
  `.execute(db)
  await migrateToHead()
  const rows = await sql`select * from invitations order by id`.execute(db)
  expect(rows.rows).toEqual([
    {
      id: 'i-link',
      tokenHash: 'hash-1',
      invitedBy: 'p-ada',
      createdAt: 10,
      expiresAt: 20,
      redeemedAt: 15,
      redeemedBy: 'p-bob',
      tenantId: 't1',
      workspaceId: 'ws-1',
    },
    {
      id: 'i-open',
      tokenHash: 'hash-2',
      invitedBy: 'p-ada',
      createdAt: 11,
      expiresAt: 21,
      redeemedAt: null,
      redeemedBy: null,
      tenantId: 't2',
      workspaceId: null,
    },
  ])
  await db.destroy()
})

// Redemption looks an invitation up by its token hash, and every invitation belongs to a tenant;
// the rebuilt table has to keep both guarantees the column list alone does not show.
const insertInvitation = (id: string, tokenHash: string, tenantId: string | null) => sql`
  insert into invitations (id, tokenHash, invitedBy, createdAt, expiresAt, tenantId)
  values (${id}, ${tokenHash}, 'p-ada', 1, 2, ${tenantId})
`

it('refuses a second invitation carrying a token hash that is already taken', async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateTo(PRE_0040)
  await migrateToHead()
  await insertInvitation('i-1', 'same-hash', 't1').execute(db)
  await expect(insertInvitation('i-2', 'same-hash', 't1').execute(db)).rejects.toThrow(
    /UNIQUE|constraint/i,
  )
  await db.destroy()
})

it('refuses an invitation that names no tenant', async () => {
  const { db, migrateTo, migrateToHead } = await openMigrationHarness(dataDir)
  await migrateTo(PRE_0040)
  await migrateToHead()
  await expect(insertInvitation('i-1', 'hash-1', null).execute(db)).rejects.toThrow(
    /NOT NULL|constraint/i,
  )
  await db.destroy()
})
