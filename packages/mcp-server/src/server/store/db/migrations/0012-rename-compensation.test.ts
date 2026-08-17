import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, type MigrationProvider, Migrator, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../../../log.js'
import { migrations } from './index.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

// Controllable rename failure: the N-th `rename()` call throws.
let failOnRenameCalls = new Set<number>()
let renameCalls = 0
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: async (from: string, to: string) => {
      renameCalls += 1
      if (failOnRenameCalls.has(renameCalls)) {
        const err = new Error(
          `injected failure on rename call #${renameCalls}`,
        ) as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      return real.rename(from, to)
    },
  }
})

const { migration } = await import('./0012-ulid-remaining-document-ids.js')

const PRE_0012 = '0011-import-fs-blobs'

interface Handle {
  db: Kysely<Record<string, Record<string, unknown>>>
  migrateToPre0012(): Promise<void>
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
  }
}

async function seedLegacyRow(
  db: Handle['db'],
  opts: { id: string; workspaceId: string; path: string },
): Promise<void> {
  await db
    .insertInto('workspaces')
    .values({ id: opts.workspaceId, createdAt: 0, updatedAt: 0 })
    .onConflict((oc) => oc.doNothing())
    .execute()
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
}

describe('0012 blob-rename compensation', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-0012-comp-'))
    renameCalls = 0
    failOnRenameCalls = new Set()
  })

  it('renames completed blobs BACK before rethrowing, so a rolled-back DB matches the disk', async () => {
    // A blob rename cannot be rolled back by the DB transaction: if a LATER
    // row in the loop throws, the first row's already-renamed blob must be
    // renamed back or it is orphaned forever once the ULID is regenerated on
    // retry. This pins that undo actually happens, and pins the undo's
    // rename() argument order (a swapped from/to would fail this test).
    const handle = await openDb()
    await handle.migrateToPre0012()
    await seedLegacyRow(handle.db, { id: 'uH6qTx6Ai2hl', workspaceId: 'ws-1', path: 'doc-a' })
    await seedLegacyRow(handle.db, { id: 'Go1G4OcJKUBu', workspaceId: 'ws-1', path: 'doc-b' })
    const blobDir = join(dataDir, 'blobs', 'ws-1', 'canvas')
    await mkdir(blobDir, { recursive: true })
    await writeFile(join(blobDir, 'uH6qTx6Ai2hl.loro'), new Uint8Array([1]))
    await writeFile(join(blobDir, 'Go1G4OcJKUBu.loro'), new Uint8Array([2]))

    failOnRenameCalls = new Set([2])

    await expect(migration.up(handle.db as never)).rejects.toThrow(/injected failure/)

    // Row A's blob was renamed on call 1, then renamed BACK when call 2
    // failed: the disk carries exactly the legacy names the rolled-back DB
    // expects.
    expect((await readdir(blobDir)).sort()).toEqual(['Go1G4OcJKUBu.loro', 'uH6qTx6Ai2hl.loro'])
    await handle.db.destroy()
  })

  it('logs an error (and still rethrows the original failure) when the undo rename itself fails', async () => {
    const handle = await openDb()
    await handle.migrateToPre0012()
    await seedLegacyRow(handle.db, { id: 'uH6qTx6Ai2hl', workspaceId: 'ws-1', path: 'doc-a' })
    await seedLegacyRow(handle.db, { id: 'Go1G4OcJKUBu', workspaceId: 'ws-1', path: 'doc-b' })
    const blobDir = join(dataDir, 'blobs', 'ws-1', 'canvas')
    await mkdir(blobDir, { recursive: true })
    await writeFile(join(blobDir, 'uH6qTx6Ai2hl.loro'), new Uint8Array([1]))
    await writeFile(join(blobDir, 'Go1G4OcJKUBu.loro'), new Uint8Array([2]))

    // Call 1: row A's forward rename (succeeds). Call 2: row B's forward
    // rename (the triggering failure). Call 3: the catch block's attempt to
    // undo row A's rename (also fails) — exercising the log.error branch.
    failOnRenameCalls = new Set([2, 3])
    const logs = captureLogsForTests()
    try {
      await expect(migration.up(handle.db as never)).rejects.toThrow(
        /injected failure on rename call #2/,
      )

      const undoFailure = logs.records.find(
        (r) => r.scope === 'migration-0012' && r.level === 'error',
      )
      expect(undoFailure?.msg).toMatch(/could not undo a blob rename/i)
      // `to` in the logged undo attempt is the ORIGINAL legacy path it was
      // trying to restore — the one deterministic side of the pair (`from`
      // is the freshly generated ULID path, not known ahead of time).
      expect(undoFailure?.data?.to).toBe(join(blobDir, 'uH6qTx6Ai2hl.loro'))
    } finally {
      logs.restore()
      await handle.db.destroy()
    }
  })
})
