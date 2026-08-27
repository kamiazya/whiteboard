import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, type MigrationProvider, Migrator, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './index.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

// The last migration a database that predates 0012 had applied — everything
// up to and including 0011, which is exactly the state a live install is in
// right before this migration ships. `upsertCanvasRow`'s nanoid rows are
// created by application code running against THIS schema, not by an older
// one, so the seed below matches the schema as it stands at 0011 rather than
// reproducing 0008's pre-rename fixture.
const PRE_0012 = '0011-import-fs-blobs'

interface Handle {
  db: Kysely<Record<string, Record<string, unknown>>>
  migrateToPre0012(): Promise<void>
  migrateTo(name: string): Promise<void>
  migrateToHead(): Promise<void>
}

async function openDb(): Promise<Handle> {
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
  const migrator = new Migrator({ db: db as never, provider })
  return {
    db,
    async migrateToPre0012() {
      const { error } = await migrator.migrateTo(PRE_0012)
      expect(error).toBeUndefined()
    },
    async migrateTo(name: string) {
      const { error } = await migrator.migrateTo(name)
      expect(error).toBeUndefined()
    },
    async migrateToHead() {
      const { error } = await migrator.migrateToLatest()
      expect(error).toBeUndefined()
    },
  }
}

async function seedThirdSiteRow(
  db: Handle['db'],
  opts: { id: string; workspaceId: string; path: string },
): Promise<void> {
  await db
    .insertInto('workspaces')
    .values({ id: opts.workspaceId, createdAt: 0, updatedAt: 0 })
    .onConflict((oc) => oc.doNothing())
    .execute()
  // Shaped exactly like `upsertCanvasRow`'s insert: no `kind` (it is left
  // null for a row created by a version/name/branch write, same as the
  // production helper).
  await db
    .insertInto('documents')
    .values({
      id: opts.id,
      workspaceId: opts.workspaceId,
      path: opts.path,
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
    .values({ documentId: opts.id, name: 'main', tipFrontiers: '', color: null, createdAt: 0 })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: `v-${opts.path}`,
      documentId: opts.id,
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
  const docKey = `canvas:${opts.id}`
  await db
    .insertInto('documentSnapshots')
    .values({
      docKey,
      chunkCount: 1,
      totalBytes: 3,
      maxChunkBytes: 1_000_000,
      frontier: new Uint8Array(),
    })
    .execute()
  await db
    .insertInto('documentSnapshotChunks')
    .values({ docKey, chunkIndex: 0, bytes: new Uint8Array([1, 2, 3]) })
    .execute()
  await db
    .insertInto('documentDeltas')
    .values({ docKey, seq: 0, bytes: new Uint8Array([4]), frontier: new Uint8Array() })
    .execute()
  await db.insertInto('documentFrontiers').values({ docKey, frontier: new Uint8Array() }).execute()
}

describe('0012-ulid-remaining-document-ids', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-0012-'))
  })

  it('re-mints a third-site nanoid row, carrying versions/branches/docKeys/blob', async () => {
    const handle = await openDb()
    await handle.migrateToPre0012()
    await seedThirdSiteRow(handle.db, {
      id: 'uH6qTx6Ai2hl',
      workspaceId: 'ws-1',
      path: 'third-site-doc',
    })
    const blobDir = join(dataDir, 'blobs', 'ws-1', 'canvas')
    await mkdir(blobDir, { recursive: true })
    await writeFile(join(blobDir, 'uH6qTx6Ai2hl.loro'), new Uint8Array([1, 2, 3]))

    // The version-carry is asserted at 0014, the last point the row still
    // exists: 0015 deletes pre-0014 version rows as legacy per-document
    // checkpoints (their frontiers point into oplogs the fold retired).
    await handle.migrateTo('0014-versions-workspace-scoped')

    const row = (await handle.db
      .selectFrom('documents')
      .selectAll()
      .where('path', '=', 'third-site-doc')
      .executeTakeFirstOrThrow()) as { id: string }
    expect(row.id).toMatch(ULID)

    const version = (await handle.db
      .selectFrom('versions')
      .selectAll()
      .executeTakeFirstOrThrow()) as { documentId: string }
    expect(version.documentId).toBe(row.id)
    const branch = (await handle.db
      .selectFrom('branches')
      .selectAll()
      .executeTakeFirstOrThrow()) as { documentId: string }
    expect(branch.documentId).toBe(row.id)

    await handle.migrateToHead()

    // migrateToHead now runs 0013 too, which rewrites the prefix this
    // migration wrote. The SEED above stays `canvas:` — it reproduces a
    // pre-0013 database, and rewriting it would leave 0013 untested.
    const newDocKey = `document:${row.id}`
    for (const table of [
      'documentSnapshots',
      'documentSnapshotChunks',
      'documentDeltas',
      'documentFrontiers',
    ]) {
      const docKeyRow = await handle.db.selectFrom(table).select('docKey').executeTakeFirstOrThrow()
      expect(docKeyRow.docKey).toBe(newDocKey)
    }

    expect(await readdir(blobDir)).toEqual([`${row.id}.loro`])
    await handle.db.destroy()
  })

  it('tolerates a missing blob rather than failing the migration', async () => {
    const handle = await openDb()
    await handle.migrateToPre0012()
    await seedThirdSiteRow(handle.db, {
      id: 'Go1G4OcJKUBu',
      workspaceId: 'ws-1',
      path: 'blobless-doc',
    })

    await handle.migrateToHead()

    const row = (await handle.db
      .selectFrom('documents')
      .selectAll()
      .where('path', '=', 'blobless-doc')
      .executeTakeFirstOrThrow()) as { id: string }
    expect(row.id).toMatch(ULID)
    await handle.db.destroy()
  })

  it('leaves a ULID row byte-identical and is idempotent across two runs', async () => {
    const handle = await openDb()
    await handle.migrateToPre0012()
    await seedThirdSiteRow(handle.db, {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      workspaceId: 'ws-1',
      path: 'modern-doc',
    })

    await handle.migrateToHead()
    // Re-running migrateToLatest is a no-op once the log already records
    // 0012 (kysely will not re-apply it), so call the migration function a
    // second time directly to pin idempotence of its own logic.
    const { migration } = await import('./0012-ulid-remaining-document-ids.js')
    await migration.up(handle.db as never)

    const row = (await handle.db.selectFrom('documents').selectAll().executeTakeFirstOrThrow()) as {
      id: string
    }
    expect(row.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    await handle.db.destroy()
  })
})
