/**
 * The digest column's DEFAULT is what the read's fallback rests on: a row
 * written before this migration has to arrive as `''` rather than as null or
 * as a missing field, because `''` is the value `isUnchangedSinceLastVersion`
 * tests for to decide it is looking at a pre-digest row.
 *
 * Pinned against a real pre-migration row rather than a simulated one. The
 * store's own test for the fallback blanks the column with an UPDATE, which
 * assumes exactly the answer this file establishes; seeding the row before
 * the column exists is what makes that assumption checked rather than
 * repeated.
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

const PRE_0026 = '0025-version-operator-actor'

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

async function versionColumns(db: Db): Promise<string[]> {
  const rows = await sql<{ name: string }>`select name from pragma_table_info('versions')`.execute(
    db,
  )
  return rows.rows.map((r) => r.name)
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'version-content-digest-'))
})

it('gives a row that predates the column an empty digest, keeping the point itself', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0026)

  // A probe, so "absent before" cannot be satisfied by a column that was
  // never going to be there.
  expect(await versionColumns(handle.db)).not.toContain('contentDigest')
  await handle.db
    .insertInto('versions')
    .values({
      id: 'v-1',
      documentId: 'doc-1',
      workspaceId: 'ws-1',
      branchName: 'main',
      auto: 0,
      label: 'a point',
      operatorKind: 'human',
      operatorActor: '',
      elementCount: 3,
      frontiers: 'ZnJvbnRpZXJz',
      createdAt: Date.now(),
    })
    .execute()

  await handle.migrateTo('head')

  expect(await versionColumns(handle.db)).toContain('contentDigest')
  const rows = await handle.db
    .selectFrom('versions')
    .select(['id', 'label', 'frontiers', 'contentDigest'])
    .execute()
  // The point survives with everything a checkout needs; only the new field
  // is blank, and blank is the honest answer — a past checkpoint's content is
  // reachable only by checking the record out, so there is nothing to
  // backfill it from.
  expect(rows).toEqual([
    { id: 'v-1', label: 'a point', frontiers: 'ZnJvbnRpZXJz', contentDigest: '' },
  ])
})
