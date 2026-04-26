import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/dist/app',
}))

const {
  getUserLibraryMetadata,
  setUserLibraryMetadata,
  deleteUserLibraryMetadata,
  removeUserLibraryMetadata,
  USER_LIBRARY_METADATA_FILENAME_SUFFIX,
} = await import('./user-library-metadata-store.js')

describe('user-library-metadata-store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'user-lib-meta-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('keeps the .meta.json suffix constant for back-compat', () => {
    expect(USER_LIBRARY_METADATA_FILENAME_SUFFIX).toBe('.meta.json')
  })

  it('returns an empty manifest when metadata does not exist', async () => {
    await expect(getUserLibraryMetadata('icons')).resolves.toEqual({
      version: 1,
      revision: 0,
      aliases: {},
      notes: {},
      scales: {},
    })
  })

  it('merges aliases, notes, and scales and increments revision', async () => {
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

  it('deletes selected alias/note/scale keys and increments revision', async () => {
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

  it('rejects revision conflicts instead of last-write-wins', async () => {
    await setUserLibraryMetadata('icons', 0, { aliases: { cloud_run: 13 } })

    await expect(
      setUserLibraryMetadata('icons', 0, { aliases: { pubsub: 7 } }),
    ).rejects.toMatchObject({
      name: 'UserLibraryMetadataConflictError',
      code: 'conflict',
    })
  })

  it('treats a manifestJson row that fails schema validation as corruption', async () => {
    const { getDb } = await import('./db/index.js')
    const { prepareDataDir } = await import('./db/prepare.js')
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
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

  it('removeUserLibraryMetadata is a no-op for missing rows', async () => {
    await expect(removeUserLibraryMetadata('ghost')).resolves.not.toThrow()
  })
})
