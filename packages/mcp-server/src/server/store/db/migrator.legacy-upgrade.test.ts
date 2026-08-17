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
  // documents table was still `canvases`, its path column was still `slug`,
  // and ids were nanoids.
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

// The last migration a database applied that predates 0012, i.e. every
// install that has run 0008 but not yet the fix for the THIRD id-minting
// site (`upsertCanvasRow`, shared by the version/name/branch stores). A
// nanoid row created by that site AFTER 0008 ran is real production data —
// 0008 could not have seen it, because it did not exist yet — so this models
// it the honest way: migrate up to the point the bug was still live, then
// insert exactly the shape that call site produced, then let the rest of
// the chain (0009 onward, including 0012) run over it.
const PRE_0012 = '0011-import-fs-blobs'

it('the REAL migrator upgrades a third-site nanoid row that postdates 0008: zero non-ULID ids remain', async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-boot-verify-third-site-'))
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
  const { error } = await new Migrator({ db: db as never, provider }).migrateTo(PRE_0012)
  expect(error).toBeUndefined()

  // Shaped exactly like `upsertCanvasRow`'s insert (documents/versions/branches
  // plus the four docKey tables a version save's document content would have
  // populated) at the CURRENT schema — 0009/0010 have already renamed
  // canvases->documents and slug->path by this point in the chain.
  await db
    .insertInto('workspaces')
    .values({ id: 'ws-third-site', createdAt: 0, updatedAt: 0 })
    .execute()
  await db
    .insertInto('documents')
    .values({
      id: 'uH6qTx6Ai2hl',
      workspaceId: 'ws-third-site',
      path: 'third-site-doc',
      displayName: null,
      isPinned: 0,
      pinOrder: null,
      currentBranch: 'main',
      createdAt: 0,
      updatedAt: 0,
    })
    .execute()
  await db
    .insertInto('branches')
    .values({
      documentId: 'uH6qTx6Ai2hl',
      name: 'main',
      tipFrontiers: '',
      color: null,
      createdAt: 0,
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: 'v-third-site',
      documentId: 'uH6qTx6Ai2hl',
      branchName: 'main',
      auto: 0,
      operatorKind: 'human',
      operatorPeerId: 'p-1',
      operatorDisplayName: 'seed',
      elementCount: 0,
      frontiers: '',
      hasThumbnail: 0,
      createdAt: 0,
    })
    .execute()
  const docKey = 'canvas:uH6qTx6Ai2hl'
  await db
    .insertInto('documentSnapshots')
    .values({
      docKey,
      chunkCount: 1,
      totalBytes: 3,
      maxChunkBytes: 1_000_000,
      frontier: Buffer.from([]),
    })
    .execute()
  await db
    .insertInto('documentSnapshotChunks')
    .values({ docKey, chunkIndex: 0, bytes: Buffer.from([1, 2, 3]) })
    .execute()
  await db
    .insertInto('documentDeltas')
    .values({ docKey, seq: 0, bytes: Buffer.from([4]), frontier: Buffer.from([]) })
    .execute()
  await db
    .insertInto('documentFrontiers')
    .values({ docKey, frontier: Buffer.from([]) })
    .execute()
  const blobDir = join(dataDir, 'blobs', 'ws-third-site', 'canvas')
  await mkdir(blobDir, { recursive: true })
  await writeFile(join(blobDir, 'uH6qTx6Ai2hl.loro'), new Uint8Array([9]))

  // What the next boot does.
  await runMigrations(db as never)

  const documentRows = (await db.selectFrom('documents').selectAll().execute()) as { id: string }[]
  for (const documentRow of documentRows) {
    expect(documentRow.id).toMatch(ULID)
  }
  const newRow = documentRows.find((r) => r.id !== 'uH6qTx6Ai2hl')
  expect(newRow).toBeDefined()

  const versionRows = (await db.selectFrom('versions').selectAll().execute()) as {
    documentId: string
  }[]
  for (const v of versionRows) expect(v.documentId).not.toBe('uH6qTx6Ai2hl')
  const branchRows = (await db.selectFrom('branches').selectAll().execute()) as {
    documentId: string
  }[]
  for (const b of branchRows) expect(b.documentId).not.toBe('uH6qTx6Ai2hl')

  for (const table of [
    'documentSnapshots',
    'documentSnapshotChunks',
    'documentDeltas',
    'documentFrontiers',
  ]) {
    const rows = (await db.selectFrom(table).select('docKey').execute()) as { docKey: string }[]
    for (const r of rows) expect(r.docKey).not.toBe(docKey)
  }

  expect(await readdir(blobDir)).toEqual([`${newRow?.id}.loro`])
  await db.destroy()
})
