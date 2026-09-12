/**
 * A checkpoint written before the digest existed is REMOVED, not carried.
 *
 * It cannot gain one — the content a past checkpoint held is reachable only by
 * checking the workspace record out at that row's frontiers, and a compacted
 * record may not reach them at all — so carrying it would mean keeping the
 * old, wrong comparison alive as a second read path for the lifetime of the
 * column. This is the assertion that makes the store's single-comparison read
 * correct rather than merely tidy, so it is pinned against a real
 * pre-migration row rather than argued.
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

it('removes a checkpoint that predates the column, since none can be backfilled', async () => {
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
  // Gone, rather than present with a blank digest. Asserted on the rows and
  // not on a count, so a migration that replaced the row with a placeholder
  // would fail here too.
  expect(await handle.db.selectFrom('versions').selectAll().execute()).toEqual([])
})

/**
 * What the sweep must NOT take. A version is a frontier plus a row, never a
 * copy of content, so what a reader loses is the ability to look back — not
 * anything a document holds now. The content itself is the workspace record's
 * snapshot, and a sweep that reached it would be the same statement with a
 * catastrophically different meaning that nothing else in this file notices.
 */
it('leaves the stored content alone, taking only the ability to look back', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0026)
  await handle.db
    .insertInto('documentSnapshots')
    .values({
      docKey: 'ws-1/workspace',
      chunkCount: 1,
      totalBytes: 4,
      maxChunkBytes: 1_000_000,
      frontier: new Uint8Array([1, 2, 3, 4]),
      generation: 1,
    })
    .execute()

  await handle.migrateTo('head')

  const rows = await handle.db
    .selectFrom('documentSnapshots')
    .select(['docKey', 'totalBytes'])
    .execute()
  expect(rows).toEqual([{ docKey: 'ws-1/workspace', totalBytes: 4 }])
})
