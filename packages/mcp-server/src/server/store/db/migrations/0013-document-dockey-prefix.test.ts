import { mkdtemp } from 'node:fs/promises'
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

// The last migration a database that predates 0013 had applied. Seeding at
// this point is what makes the test exercise the real upgrade path rather
// than a hand-built table.
const PRE_0013 = '0012-ulid-remaining-document-ids'

const DOC_A = '01JQZ0000000000000000000A0'
const DOC_B = '01JQZ0000000000000000000B0'
const WORKSPACE = 'ws-1'

interface Handle {
  db: Kysely<Record<string, Record<string, unknown>>>
  migrateToPre0013(): Promise<void>
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
    async migrateToPre0013() {
      const { error } = await migrator.migrateTo(PRE_0013)
      expect(error).toBeUndefined()
    },
    async migrateToHead() {
      const { error } = await migrator.migrateToLatest()
      expect(error).toBeUndefined()
    },
  }
}

/** Writes one document's rows into all four docKey tables under `docKey`. */
async function seedDocKeyRows(db: Handle['db'], docKey: string): Promise<void> {
  await db
    .insertInto('documentSnapshots')
    .values({
      docKey,
      chunkCount: 1,
      totalBytes: 3,
      maxChunkBytes: 1_000_000,
      frontier: Uint8Array.from([1]),
    })
    .execute()
  await db
    .insertInto('documentSnapshotChunks')
    .values({ docKey, chunkIndex: 0, bytes: Uint8Array.from([1, 2, 3]) })
    .execute()
  await db
    .insertInto('documentDeltas')
    .values({ docKey, seq: 1, bytes: Uint8Array.from([4]), frontier: Uint8Array.from([2]) })
    .execute()
  await db
    .insertInto('documentFrontiers')
    .values({ docKey, frontier: Uint8Array.from([3]) })
    .execute()
}

const DOC_KEY_TABLES = [
  'documentSnapshots',
  'documentSnapshotChunks',
  'documentDeltas',
  'documentFrontiers',
] as const

async function docKeysIn(db: Handle['db'], table: string): Promise<string[]> {
  const rows = await db.selectFrom(table).select('docKey').execute()
  return rows.map((row) => row.docKey as string).sort()
}

describe('0013-document-dockey-prefix', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wb-0013-'))
  })

  it('rewrites the canvas: docKey prefix to document: in every docKey table', async () => {
    const handle = await openDb()
    await handle.migrateToPre0013()
    await seedDocKeyRows(handle.db, `canvas:${DOC_A}`)
    await seedDocKeyRows(handle.db, `canvas:${DOC_B}`)

    await handle.migrateToHead()

    for (const table of DOC_KEY_TABLES) {
      expect(await docKeysIn(handle.db, table)).toEqual([`document:${DOC_A}`, `document:${DOC_B}`])
    }
  })

  it('leaves a workspace-tree docKey alone', async () => {
    const handle = await openDb()
    await handle.migrateToPre0013()
    await seedDocKeyRows(handle.db, `workspace-tree:${WORKSPACE}`)

    await handle.migrateToHead()

    for (const table of DOC_KEY_TABLES) {
      expect(await docKeysIn(handle.db, table)).toEqual([`workspace-tree:${WORKSPACE}`])
    }
  })

  // A documentId is a ULID, so `canvas:` can only ever appear as the prefix —
  // this key is synthetic. It exists because the rewrite is a string
  // operation, and one written as a blanket REPLACE would also rewrite the
  // word further along. The fixture must MATCH the `like 'canvas:%'` filter
  // and carry a second occurrence, or the mutation never reaches the SET
  // expression: a first version seeded `workspace-tree:has-canvas:inside`,
  // which the filter excludes outright, and swapping substr for REPLACE left
  // it green.
  it('rewrites only the prefix, not a later occurrence in the same key', async () => {
    const handle = await openDb()
    await handle.migrateToPre0013()
    await seedDocKeyRows(handle.db, `canvas:has-canvas:inside`)

    await handle.migrateToHead()

    for (const table of DOC_KEY_TABLES) {
      expect(await docKeysIn(handle.db, table)).toEqual(['document:has-canvas:inside'])
    }
  })

  it('leaves a key that merely contains the old word untouched', async () => {
    const handle = await openDb()
    await handle.migrateToPre0013()
    await seedDocKeyRows(handle.db, `workspace-tree:has-canvas:inside`)

    await handle.migrateToHead()

    for (const table of DOC_KEY_TABLES) {
      expect(await docKeysIn(handle.db, table)).toEqual(['workspace-tree:has-canvas:inside'])
    }
  })

  it('is idempotent — a database already on document: keys is left unchanged', async () => {
    const handle = await openDb()
    await handle.migrateToPre0013()
    await seedDocKeyRows(handle.db, `document:${DOC_A}`)

    await handle.migrateToHead()

    for (const table of DOC_KEY_TABLES) {
      expect(await docKeysIn(handle.db, table)).toEqual([`document:${DOC_A}`])
    }
  })
})
