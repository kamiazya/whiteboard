import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSchema } from '../schema.js'
import { migration as migration0001 } from './0001-init.js'
import { migration as migration0002 } from './0002-canvases-last-compacted-at.js'
import { migration as migration0003 } from './0003-canvas-doc-store.js'
import { migration as migration0005 } from './0005-canvases-kind.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

// Controllable rename failure: the N-th rename call throws EACCES.
let failOnRenameCall = Infinity
let renameCalls = 0
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: async (from: string, to: string) => {
      renameCalls += 1
      if (renameCalls === failOnRenameCall) {
        const err = new Error('EACCES: injected') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      return real.rename(from, to)
    },
  }
})

const { migration } = await import('./0008-ulid-legacy-canvas-ids.js')

async function createMemoryDb(): Promise<Kysely<DatabaseSchema>> {
  const db = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new LibsqlNativeDatabase(':memory:') as unknown as ConstructorParameters<
        typeof SqliteDialect
      >[0]['database'],
    }),
  })
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  await migration0001.up(db as unknown as Kysely<unknown>)
  await migration0002.up(db as unknown as Kysely<unknown>)
  await migration0003.up(db as unknown as Kysely<unknown>)
  await migration0005.up(db as unknown as Kysely<unknown>)
  return db
}

async function seed(db: Kysely<DatabaseSchema>, id: string, slug: string) {
  await db
    .insertInto('workspaces')
    .values({ id: 'ws-1', createdAt: 0, updatedAt: 0 })
    .onConflict((oc) => oc.doNothing())
    .execute()
  await db
    .insertInto('canvases')
    .values({
      id,
      workspaceId: 'ws-1',
      slug,
      displayName: null,
      isPinned: 0,
      pinOrder: null,
      currentBranch: 'main',
      createdAt: 0,
      updatedAt: 0,
      kind: 'spatial',
    })
    .execute()
}

describe('0008 blob-rename compensation', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-0008-comp-'))
    renameCalls = 0
    failOnRenameCall = Infinity
  })

  it('renames completed blobs BACK before rethrowing, so a rolled-back DB matches the disk', async () => {
    // The migrator wraps up() in a transaction: a throw rolls the DB back to
    // nanoid ids. A blob already renamed to a fresh ULID would then be
    // orphaned forever — the ULID is regenerated on the next attempt, so
    // nothing could ever find it again. The compensating renames put the
    // disk back too, making the migration safe to retry.
    const db = await createMemoryDb()
    await seed(db, 'aaaaaaaaaaaa', 'doc-a')
    await seed(db, 'bbbbbbbbbbbb', 'doc-b')
    const blobDir = join(dataDir, 'blobs', 'ws-1', 'canvas')
    await mkdir(blobDir, { recursive: true })
    await writeFile(join(blobDir, 'aaaaaaaaaaaa.loro'), new Uint8Array([1]))
    await writeFile(join(blobDir, 'bbbbbbbbbbbb.loro'), new Uint8Array([2]))

    failOnRenameCall = 2

    await expect(migration.up(db as unknown as Kysely<unknown>)).rejects.toThrow(/EACCES/)

    // Row A\'s blob was renamed on call 1, then renamed BACK when call 2
    // failed: the disk carries exactly the nanoid names the rolled-back DB
    // expects.
    expect((await readdir(blobDir)).sort()).toEqual(['aaaaaaaaaaaa.loro', 'bbbbbbbbbbbb.loro'])
  })
})
