import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { expect, it, vi } from 'vitest'

let dataDir = ''
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const { runMigrations } = await import('./migrator.js')
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

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
  // Run every migration once (fresh dir, 0008 no-ops), then rewind ONLY the
  // 0008 log entry and inject the legacy state — exactly the shape a real
  // pre-upgrade data dir presents at next boot.
  await runMigrations(db as never)
  await sql`DELETE FROM kysely_migration WHERE name = '0008-ulid-legacy-canvas-ids'`.execute(db)
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

  await runMigrations(db as never)

  const row = (await db.selectFrom('canvases').selectAll().executeTakeFirstOrThrow()) as {
    id: string
  }
  expect(row.id).toMatch(ULID)
  expect(await readdir(blobDir)).toEqual([`${row.id}.loro`])
  await db.destroy()
})
