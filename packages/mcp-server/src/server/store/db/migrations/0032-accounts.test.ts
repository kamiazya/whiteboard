/**
 * ADR-0045 decision 5: each existing profile becomes one account plus one
 * user, and every credential it held becomes a binding on that account.
 * Mirrors 0030-workspace-members-only.test.ts's shape.
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

const PRE_0032 = '0031-tenants'

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

async function seedProfiles(db: Db): Promise<void> {
  await db
    .insertInto('memberProfiles')
    .values([
      { id: 'p-ada', displayName: 'Ada', createdAt: 1, updatedAt: 1 },
      { id: 'p-bob', displayName: 'Bob', createdAt: 2, updatedAt: 2 },
    ])
    .execute()
  await db
    .insertInto('profileCredentials')
    .values([
      { credentialId: 'cred-a1', origin: 'https://a.example', profileId: 'p-ada' },
      { credentialId: 'cred-a2', origin: 'https://b.example', profileId: 'p-ada' },
      { credentialId: 'cred-b1', origin: 'https://a.example', profileId: 'p-bob' },
    ])
    .execute()
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'accounts-'))
})

it('turns each profile into one account and each of its credentials into a binding', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0032)
  await seedProfiles(handle.db)
  await handle.migrateTo('head')

  const profiles = await handle.db
    .selectFrom('memberProfiles')
    .select(['id', 'accountId'])
    .orderBy('id')
    .execute()
  const accounts = await handle.db.selectFrom('accounts').selectAll().execute()
  const bindings = await handle.db
    .selectFrom('accountBindings')
    .selectAll()
    .orderBy('subject')
    .execute()

  expect(accounts).toHaveLength(2)
  const accountOf = Object.fromEntries(profiles.map((p) => [p.id, p.accountId]))
  expect(new Set(Object.values(accountOf))).toEqual(new Set(accounts.map((a) => a.id)))
  expect(bindings.map((b) => [b.authenticator, b.subject, b.accountId])).toEqual([
    ['passkey', JSON.stringify(['https://a.example', 'cred-a1']), accountOf['p-ada']],
    ['passkey', JSON.stringify(['https://a.example', 'cred-b1']), accountOf['p-bob']],
    ['passkey', JSON.stringify(['https://b.example', 'cred-a2']), accountOf['p-ada']],
  ])
  const tables = await sql<{ name: string }>`select name from sqlite_master where type = 'table'`
    .execute(handle.db)
    .then((r) => r.rows.map((row) => row.name))
  expect(tables).not.toContain('profileCredentials')
})

it('round-trips down to the credentials it started from', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0032)
  await seedProfiles(handle.db)
  await handle.migrateTo('head')
  await handle.migrateTo(PRE_0032)

  const credentials = await handle.db
    .selectFrom('profileCredentials')
    .select(['credentialId', 'origin', 'profileId', 'tenantId'])
    .orderBy('credentialId')
    .execute()
  expect(credentials).toEqual([
    {
      credentialId: 'cred-a1',
      origin: 'https://a.example',
      profileId: 'p-ada',
      tenantId: 'self-host',
    },
    {
      credentialId: 'cred-a2',
      origin: 'https://b.example',
      profileId: 'p-ada',
      tenantId: 'self-host',
    },
    {
      credentialId: 'cred-b1',
      origin: 'https://a.example',
      profileId: 'p-bob',
      tenantId: 'self-host',
    },
  ])
})
