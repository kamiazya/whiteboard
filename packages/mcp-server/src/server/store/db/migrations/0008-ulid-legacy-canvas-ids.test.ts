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

const { migration } = await import('./0008-ulid-legacy-canvas-ids.js')

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

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
  await db
    .insertInto('branches')
    .values({ canvasId: id, name: 'main', tipFrontiers: '', color: null, createdAt: 0 })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: `v-${slug}`,
      canvasId: id,
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

describe('0008-ulid-legacy-canvas-ids', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-0008-'))
  })

  it('rewrites a nanoid row to a fresh ULID, carrying versions, branches, and the blob', async () => {
    const db = await createMemoryDb()
    await seed(db, 'uH6qTx6Ai2hl', 'legacy-doc')
    const blobDir = join(dataDir, 'blobs', 'ws-1', 'canvas')
    await mkdir(blobDir, { recursive: true })
    await writeFile(join(blobDir, 'uH6qTx6Ai2hl.loro'), new Uint8Array([1, 2, 3]))

    await migration.up(db as unknown as Kysely<unknown>)

    const row = await db
      .selectFrom('canvases')
      .selectAll()
      .where('slug', '=', 'legacy-doc')
      .executeTakeFirstOrThrow()
    expect(row.id).toMatch(ULID)

    const version = await db.selectFrom('versions').selectAll().executeTakeFirstOrThrow()
    expect(version.canvasId).toBe(row.id)
    const branch = await db.selectFrom('branches').selectAll().executeTakeFirstOrThrow()
    expect(branch.canvasId).toBe(row.id)

    expect(await readdir(blobDir)).toEqual([`${row.id}.loro`])
  })

  it('leaves ULID rows byte-identical and is idempotent', async () => {
    const db = await createMemoryDb()
    await seed(db, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'modern-doc')

    await migration.up(db as unknown as Kysely<unknown>)
    await migration.up(db as unknown as Kysely<unknown>)

    const row = await db.selectFrom('canvases').selectAll().executeTakeFirstOrThrow()
    expect(row.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
  })

  it('survives a missing blob file rather than failing bootstrap', async () => {
    // A row can outlive its blob (a crashed delete, a hand-pruned data dir).
    // The id rewrite is still worth doing — the row is what darkens the
    // listing — and a migration that throws turns startup into an outage.
    const db = await createMemoryDb()
    await seed(db, 'Go1G4OcJKUBu', 'blobless-doc')

    await migration.up(db as unknown as Kysely<unknown>)

    const row = await db.selectFrom('canvases').selectAll().executeTakeFirstOrThrow()
    expect(row.id).toMatch(ULID)
  })
})
