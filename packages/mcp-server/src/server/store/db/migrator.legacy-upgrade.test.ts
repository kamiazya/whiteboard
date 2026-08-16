import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, type MigrationProvider, Migrator, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { expect, it, vi } from 'vitest'
import { migrations } from './migrations/index.js'

let dataDir = ''
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const { runMigrations } = await import('./migrator.js')
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

/**
 * The last migration a pre-0008 data dir had applied. Migrating exactly this
 * far is what makes the legacy state below real: the alternative — running
 * everything and then deleting 0008's log row — models a database that cannot
 * exist, and breaks the moment 0008 stops being the newest migration (kysely
 * rejects a log with a hole in it).
 */
const PRE_0008 = '0007-adopt-workspace-tree'

it('the REAL migrator upgrades a pre-0008 data dir: nanoid row -> ULID, blob follows', async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-boot-verify-'))
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
  const { error } = await new Migrator({ db: db as never, provider }).migrateTo(PRE_0008)
  expect(error).toBeUndefined()

  // The legacy state, written against the schema as it stood at 0007: the
  // documents table was still `canvases`, and ids were nanoids.
  await db.insertInto('workspaces').values({ id: 'ws-boot', createdAt: 0, updatedAt: 0 }).execute()
  await db
    .insertInto('canvases')
    .values({
      id: 'uH6qTx6Ai2hl',
      workspaceId: 'ws-boot',
      slug: 'legacy',
      isPinned: 0,
      currentBranch: 'main',
      createdAt: 0,
      updatedAt: 0,
      kind: 'spatial',
    })
    .execute()
  const blobDir = join(dataDir, 'blobs', 'ws-boot', 'canvas')
  await mkdir(blobDir, { recursive: true })
  await writeFile(join(blobDir, 'uH6qTx6Ai2hl.loro'), new Uint8Array([9]))

  // What the next boot does.
  await runMigrations(db as never)

  // Read back through the CURRENT name, so this also pins that 0009 carried
  // the row across the rename rather than leaving it behind.
  const row = (await db.selectFrom('documents').selectAll().executeTakeFirstOrThrow()) as {
    id: string
  }
  expect(row.id).toMatch(ULID)
  expect(await readdir(blobDir)).toEqual([`${row.id}.loro`])
  await db.destroy()
})
