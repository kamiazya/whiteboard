// user-library-metadata-store does no FS writes outside the DB and no
// internal Kysely transactions, so it qualifies for the file-scoped fixture
// + per-test BEGIN/ROLLBACK pattern. Migrations run once for the whole file
// instead of per `it`. See palette-store.test.ts for the rationale on why
// raw BEGIN/ROLLBACK is used instead of `db.transaction().execute(...)`.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { describe, expect, test as baseTest, vi } from 'vitest'

let tempDirRef = ''

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDirRef
  },
  getDataDir: () => tempDirRef,
  WHITEBOARD_ROOT: '/tmp',
  REPO_ROOT: '/tmp',
}))

const {
  getUserLibraryMetadata,
  setUserLibraryMetadata,
  deleteUserLibraryMetadata,
  removeUserLibraryMetadata,
  USER_LIBRARY_METADATA_FILENAME_SUFFIX,
} = await import('./user-library-metadata-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

interface StoreFixture {
  db: Awaited<ReturnType<typeof createIsolatedDb>>['db']
  tempDir: string
}

const test = baseTest.extend<{ store: StoreFixture }>({
  store: [
    // vitest's test.extend requires object destructuring on the first
    // parameter at runtime; renaming to a plain identifier throws
    // FixtureParseError.
    // biome-ignore lint/correctness/noEmptyPattern: vitest fixture API requires object destructuring
    async ({}, use) => {
      const dir = await mkdtemp(join(tmpdir(), 'user-lib-meta-test-'))
      tempDirRef = dir
      const handle = await createIsolatedDb({ dataDir: dir })
      await use({ db: handle.db, tempDir: dir })
      await handle.dispose()
      await rm(dir, { recursive: true, force: true })
      tempDirRef = ''
    },
    { scope: 'file' },
  ],
})

test.aroundEach(async (runTest, { store }) => {
  await sql`BEGIN`.execute(store.db)
  try {
    await runTest()
  } finally {
    await sql`ROLLBACK`.execute(store.db)
  }
})

describe('user-library-metadata-store', () => {
  test('keeps the .meta.json suffix constant for back-compat', () => {
    expect(USER_LIBRARY_METADATA_FILENAME_SUFFIX).toBe('.meta.json')
  })

  test('returns an empty manifest when metadata does not exist', async () => {
    await expect(getUserLibraryMetadata('icons')).resolves.toEqual({
      version: 1,
      revision: 0,
      aliases: {},
      notes: {},
      scales: {},
    })
  })

  test('merges aliases, notes, and scales and increments revision', async () => {
    const first = await setUserLibraryMetadata('icons', 0, {
      aliases: { cloud_run: 13 },
      notes: { '13': 'preferred icon' },
    })
    expect(first).toEqual({
      version: 1,
      revision: 1,
      aliases: { cloud_run: 13 },
      notes: { '13': 'preferred icon' },
      scales: {},
    })

    await expect(
      setUserLibraryMetadata('icons', 1, {
        aliases: { pubsub: 7 },
        scales: { '13': 1.25 },
      }),
    ).resolves.toEqual({
      version: 1,
      revision: 2,
      aliases: { cloud_run: 13, pubsub: 7 },
      notes: { '13': 'preferred icon' },
      scales: { '13': 1.25 },
    })
  })

  test('deletes selected alias/note/scale keys and increments revision', async () => {
    await setUserLibraryMetadata('icons', 0, {
      aliases: { cloud_run: 13, pubsub: 7 },
      notes: { '13': 'preferred icon', '7': 'event bus' },
      scales: { '13': 1.25, '7': 0.8 },
    })

    await expect(
      deleteUserLibraryMetadata('icons', 1, {
        aliasKeys: ['cloud_run'],
        noteKeys: ['13'],
        scaleKeys: ['7'],
      }),
    ).resolves.toEqual({
      version: 1,
      revision: 2,
      aliases: { pubsub: 7 },
      notes: { '7': 'event bus' },
      scales: { '13': 1.25 },
    })
  })

  test('rejects revision conflicts instead of last-write-wins', async () => {
    await setUserLibraryMetadata('icons', 0, { aliases: { cloud_run: 13 } })

    await expect(
      setUserLibraryMetadata('icons', 0, { aliases: { pubsub: 7 } }),
    ).rejects.toMatchObject({
      name: 'UserLibraryMetadataConflictError',
      code: 'conflict',
    })
  })

  test('treats a manifestJson row that fails schema validation as corruption', async ({
    store,
  }) => {
    const { getDb } = await import('./db/index.js')
    const { prepareDataDir } = await import('./db/prepare.js')
    await prepareDataDir(store.tempDir)
    const db = await getDb(store.tempDir)
    const now = Date.now()
    // Seed a parent row so the FK on user_library_metadata.name resolves.
    await db
      .insertInto('user_libraries')
      .values({ name: 'icons', itemCount: null, createdAt: now, updatedAt: now })
      .onConflict((oc) => oc.column('name').doNothing())
      .execute()
    await db
      .insertInto('user_library_metadata')
      .values({ name: 'icons', manifestJson: 'not-json', updatedAt: now })
      .onConflict((oc) =>
        oc.column('name').doUpdateSet({ manifestJson: 'not-json', updatedAt: now }),
      )
      .execute()

    await expect(
      setUserLibraryMetadata('icons', 0, { aliases: { cloud_run: 13 } }),
    ).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      code: 'corrupt_stored_data',
    })

    const row = await db
      .selectFrom('user_library_metadata')
      .select(['manifestJson'])
      .where('name', '=', 'icons')
      .executeTakeFirst()
    expect(row?.manifestJson).toBe('not-json')
  })

  test('removeUserLibraryMetadata is a no-op for missing rows', async () => {
    await expect(removeUserLibraryMetadata('ghost')).resolves.not.toThrow()
  })
})
