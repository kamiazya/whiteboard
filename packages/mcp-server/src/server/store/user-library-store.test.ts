import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// CRUD tests for user libraries persisted across sessions. Backed by the
// sqlite metadata store + .excalidrawlib blobs under blobs/.user-libraries/.

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp',
  REPO_ROOT: '/tmp',
}))

const {
  saveUserLibrary,
  listUserLibraries,
  loadUserLibrary,
  removeUserLibrary,
  USER_LIBRARY_DIRNAME,
} = await import('./user-library-store.js')

const SAMPLE_LIB = {
  type: 'excalidrawlib' as const,
  version: 1 as const,
  library: [
    [
      {
        id: 'el-1',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      },
    ],
  ],
}

describe('user-library-store', () => {
  let handle: Awaited<ReturnType<typeof import('./db/test-helpers.js').createIsolatedDb>>

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'user-lib-test-'))
    const { createIsolatedDb } = await import('./db/test-helpers.js')
    handle = await createIsolatedDb({ dataDir: tempDir })
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('keeps USER_LIBRARY_DIRNAME at .user-libraries for back-compat', () => {
    expect(USER_LIBRARY_DIRNAME).toBe('.user-libraries')
  })

  it('returns an empty array from listUserLibraries before anything is saved', async () => {
    const libs = await listUserLibraries()
    expect(libs).toEqual([])
  })

  it('returns a corruption error from loadUserLibrary for invalid .excalidrawlib files', async () => {
    await mkdir(join(tempDir, 'blobs', '.user-libraries'), { recursive: true })
    await writeFile(join(tempDir, 'blobs', '.user-libraries', 'broken.excalidrawlib'), 'not-json')

    await expect(loadUserLibrary('broken')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      code: 'corrupt_stored_data',
    })
  })

  it('returns metadata from saveUserLibrary -> listUserLibraries', async () => {
    await saveUserLibrary('my-icons', SAMPLE_LIB)
    const libs = await listUserLibraries()
    expect(libs).toHaveLength(1)
    expect(libs[0].name).toBe('my-icons')
    expect(libs[0].itemCount).toBe(1)
    expect(libs[0].path).toMatch(/blobs\/\.user-libraries\/my-icons\.excalidrawlib$/)
  })

  it('round-trips saved content through loadUserLibrary', async () => {
    await saveUserLibrary('my-icons', SAMPLE_LIB)
    const loaded = await loadUserLibrary('my-icons')
    expect(loaded).toEqual(SAMPLE_LIB)
  })

  it('overwrites when saving under the same name', async () => {
    await saveUserLibrary('dupe', SAMPLE_LIB)
    const replaced = { ...SAMPLE_LIB, library: [...SAMPLE_LIB.library, SAMPLE_LIB.library[0]] }
    await saveUserLibrary('dupe', replaced)
    const loaded = await loadUserLibrary('dupe')
    expect((loaded as typeof replaced).library).toHaveLength(2)
    const libs = await listUserLibraries()
    expect(libs.find((l) => l.name === 'dupe')?.itemCount).toBe(2)
  })

  it('deletes the file with removeUserLibrary', async () => {
    await saveUserLibrary('a', SAMPLE_LIB)
    await saveUserLibrary('b', SAMPLE_LIB)
    await removeUserLibrary('a')
    const libs = await listUserLibraries()
    expect(libs.map((l) => l.name)).toEqual(['b'])
  })

  it('treats removing a missing library as a no-op', async () => {
    await expect(removeUserLibrary('ghost')).resolves.not.toThrow()
  })

  it('does not swallow non-ENOENT errors in removeUserLibrary', async () => {
    await mkdir(join(tempDir, 'blobs', '.user-libraries', 'broken.excalidrawlib'), {
      recursive: true,
    })

    await expect(removeUserLibrary('broken')).rejects.toThrow()
  })

  it('returns null when loading a missing library', async () => {
    const loaded = await loadUserLibrary('ghost')
    expect(loaded).toBeNull()
  })

  it('rejects names containing path traversal characters', async () => {
    await expect(saveUserLibrary('../escape', SAMPLE_LIB)).rejects.toThrow(/invalid/i)
    await expect(saveUserLibrary('a/b', SAMPLE_LIB)).rejects.toThrow(/invalid/i)
    await expect(saveUserLibrary('', SAMPLE_LIB)).rejects.toThrow(/invalid/i)
  })
})
