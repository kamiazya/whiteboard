/**
 * The version row's miniature is retired. This pins that BOTH halves of it
 * go — the column and the PNGs — because dropping only the column would
 * leave the bytes on disk with nothing left that could ever name them, which
 * is the shape an operator finds years later and cannot explain.
 */
import { mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises'
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

const PRE_0024 = '0023-drop-branches'

interface Handle {
  db: Kysely<Record<string, Record<string, unknown>>>
  migrateTo(name: string): Promise<void>
  migrateToHead(): Promise<void>
  migrateToHeadRaw(): Promise<unknown>
}

async function openDb(): Promise<Handle> {
  const db = new Kysely<Record<string, Record<string, unknown>>>({
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
      const { error } = await migrator.migrateTo(name)
      expect(error).toBeUndefined()
    },
    async migrateToHead() {
      const { error } = await migrator.migrateToLatest()
      expect(error).toBeUndefined()
    },
    async migrateToHeadRaw() {
      return (await migrator.migrateToLatest()).error
    },
  }
}

async function versionColumns(db: Handle['db']): Promise<string[]> {
  const rows = await sql<{ name: string }>`select name from pragma_table_info('versions')`.execute(
    db,
  )
  return rows.rows.map((r) => r.name)
}

/** What `blobs/<workspaceId>/versions/` holds, or `null` when it is gone. */
async function pictureFiles(workspaceId: string): Promise<string[] | null> {
  try {
    return await readdir(join(dataDir, 'blobs', workspaceId, 'versions'))
  } catch {
    return null
  }
}

async function seedVersionRow(handle: Handle, id: string, workspaceId: string): Promise<void> {
  await handle.db
    .insertInto('versions')
    .values({
      id,
      documentId: 'doc-1',
      workspaceId,
      branchName: 'main',
      auto: 0,
      label: 'a point',
      operatorKind: 'human',
      operatorPeerId: 'peer-1',
      elementCount: 1,
      frontiers: '',
      hasThumbnail: 1,
      createdAt: Date.now(),
    })
    .execute()
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'drop-version-thumbnails-'))
})

it('drops the column and the pictures, keeping the points themselves', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0024)

  // Probes, so "gone at head" cannot be satisfied by something that was
  // never there in the first place.
  expect(await versionColumns(handle.db)).toContain('hasThumbnail')
  await seedVersionRow(handle, 'v-1', 'ws-1')
  await mkdir(join(dataDir, 'blobs', 'ws-1', 'versions'), { recursive: true })
  await writeFile(join(dataDir, 'blobs', 'ws-1', 'versions', 'v-1.png'), 'png-ish')
  expect(await pictureFiles('ws-1')).toEqual(['v-1.png'])

  await handle.migrateToHead()

  expect(await versionColumns(handle.db)).not.toContain('hasThumbnail')
  expect(await pictureFiles('ws-1')).toBeNull()
  // The saved point survives its picture: what a version holds is a frontier
  // into the workspace record, and that is untouched by any of this.
  const rows = await handle.db.selectFrom('versions').select(['id', 'label']).execute()
  expect(rows).toEqual([{ id: 'v-1', label: 'a point' }])
})

// The walk is over every workspace, not the one a caller happened to name —
// there is no caller, and a deployment holding several would otherwise keep
// the pictures of all but the first.
it('sweeps every workspace, and leaves the rest of the blob tree alone', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0024)
  await seedVersionRow(handle, 'v-1', 'ws-1')
  await seedVersionRow(handle, 'v-2', 'ws-2')
  for (const workspaceId of ['ws-1', 'ws-2']) {
    await mkdir(join(dataDir, 'blobs', workspaceId, 'versions'), { recursive: true })
    await writeFile(join(dataDir, 'blobs', workspaceId, 'versions', 'v.png'), 'png-ish')
  }
  // An uploaded image, which lives beside the versions tree and stays.
  await mkdir(join(dataDir, 'blobs', 'ws-1', 'files'), { recursive: true })
  await writeFile(join(dataDir, 'blobs', 'ws-1', 'files', 'kept.bin'), 'bytes')

  await handle.migrateToHead()

  expect(await pictureFiles('ws-1')).toBeNull()
  expect(await pictureFiles('ws-2')).toBeNull()
  expect(await readdir(join(dataDir, 'blobs', 'ws-1'))).toEqual(['files'])
})

// A deployment that never saved a bookmark has no blobs directory at all,
// and a migration that throws on that is a daemon that will not start.
it('runs against a data directory with no blobs at all', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0024)
  await handle.migrateToHead()
  expect(await versionColumns(handle.db)).not.toContain('hasThumbnail')
})

// Swallowing this would drop the column while the pictures stayed on disk —
// the unnameable-bytes state the two halves exist to prevent, and with the
// schema change recorded there is nothing left that could collect them. So
// the migration must abort UNRECORDED and retry on the next start.
//
// A self-referential symlink rather than an unreadable directory: `readdir`
// answers ELOOP for every user, so this runs as root too. The permission
// case is the same branch, and a test only CI can execute is one nobody
// watches fail.
it('aborts unrecorded on an unexpected filesystem error instead of dropping the column anyway', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0024)
  await seedVersionRow(handle, 'v-1', 'ws-1')
  await mkdir(join(dataDir, 'blobs', 'ws-1'), { recursive: true })
  await symlink('versions', join(dataDir, 'blobs', 'ws-1', 'versions'))

  const error = await handle.migrateToHeadRaw()

  expect((error as NodeJS.ErrnoException | undefined)?.code).toBe('ELOOP')
  // Unrecorded, so the next start runs it again. A migration that reported
  // success here would have retired the only thing that knows the pictures
  // it failed to delete exist.
  expect(await versionColumns(handle.db)).toContain('hasThumbnail')
})
