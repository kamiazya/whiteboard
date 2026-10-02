/**
 * Pins the no-FK house style (0016/0017) and that the three tables do not
 * exist before this migration runs.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Kysely, sql } from 'kysely'
import { beforeEach, expect, it, vi } from 'vitest'
import { type MigrationHarness, openMigrationHarness } from '../test-helpers.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const PRE_0028 = '0027-version-attestation'

type Db = Kysely<Record<string, Record<string, unknown>>>

async function openDb(): Promise<MigrationHarness> {
  return openMigrationHarness(dataDir)
}

async function tableNames(db: Db): Promise<string[]> {
  const rows = await sql<{
    name: string
  }>`select name from sqlite_master where type = 'table'`.execute(db)
  return rows.rows.map((r) => r.name)
}

async function foreignKeysOf(db: Db, table: string): Promise<unknown[]> {
  const rows = await sql`select * from pragma_foreign_key_list('${sql.raw(table)}')`.execute(db)
  return rows.rows
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'member-profiles-'))
})

it('creates the three membership tables, absent before and empty after it with no foreign keys', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0028)
  const before = await tableNames(handle.db)
  expect(before).not.toContain('memberProfiles')
  expect(before).not.toContain('profileCredentials')
  expect(before).not.toContain('workspaceMemberships')

  // 0032 replaced profileCredentials with the account tables (ADR-0045), so
  // this migration's own shape is read at its own point in the log.
  await handle.migrateTo('0028-member-profiles')

  const after = await tableNames(handle.db)
  expect(after).toContain('memberProfiles')
  expect(after).toContain('profileCredentials')
  expect(after).toContain('workspaceMemberships')

  for (const table of ['memberProfiles', 'profileCredentials', 'workspaceMemberships']) {
    expect(await foreignKeysOf(handle.db, table)).toEqual([])
    const rows = await handle.db.selectFrom(table).selectAll().execute()
    expect(rows).toEqual([])
  }
})
