import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  loadInstalledLibraries,
  addInstalledLibrary,
  removeInstalledLibrary,
} = await import('./library-store.js')

describe('library-store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-lib-store-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty urls for an uninitialized session', async () => {
    const libs = await loadInstalledLibraries('sid-new')
    expect(libs).toEqual({ urls: [] })
  })

  it('returns a corruption error for invalid .libraries.json instead of falling back to an empty array', async () => {
    await mkdir(join(tempDir, 'sid-corrupt'), { recursive: true })
    await writeFile(join(tempDir, 'sid-corrupt', '.libraries.json'), 'not-json')

    await expect(loadInstalledLibraries('sid-corrupt')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      code: 'corrupt_stored_data',
    })
  })

  it('returns a corruption error for schema-mismatched .libraries.json files', async () => {
    await mkdir(join(tempDir, 'sid-shape'), { recursive: true })
    await writeFile(join(tempDir, 'sid-shape', '.libraries.json'), JSON.stringify({ urls: 'oops' }))

    await expect(loadInstalledLibraries('sid-shape')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      code: 'corrupt_stored_data',
    })
  })

  it('persists data across addInstalledLibrary -> loadInstalledLibraries', async () => {
    await addInstalledLibrary('sid-1', 'https://libraries.excalidraw.com/libraries/foo.excalidrawlib')
    const libs = await loadInstalledLibraries('sid-1')
    expect(libs.urls).toEqual(['https://libraries.excalidraw.com/libraries/foo.excalidrawlib'])
  })

  it('does not duplicate the same URL when added twice', async () => {
    const url = 'https://libraries.excalidraw.com/libraries/foo.excalidrawlib'
    await addInstalledLibrary('sid-2', url)
    await addInstalledLibrary('sid-2', url)
    const libs = await loadInstalledLibraries('sid-2')
    expect(libs.urls).toEqual([url])
  })

  it('removes a URL with removeInstalledLibrary', async () => {
    const url1 = 'https://libraries.excalidraw.com/libraries/a.excalidrawlib'
    const url2 = 'https://libraries.excalidraw.com/libraries/b.excalidrawlib'
    await addInstalledLibrary('sid-3', url1)
    await addInstalledLibrary('sid-3', url2)
    await removeInstalledLibrary('sid-3', url1)
    const libs = await loadInstalledLibraries('sid-3')
    expect(libs.urls).toEqual([url2])
  })

  it('treats removing a missing URL as a no-op', async () => {
    await addInstalledLibrary('sid-4', 'https://a.excalidrawlib')
    const before = await loadInstalledLibraries('sid-4')
    await removeInstalledLibrary('sid-4', 'https://nonexistent.excalidrawlib')
    const after = await loadInstalledLibraries('sid-4')
    expect(after).toEqual(before)
  })

  it('keeps URLs isolated across sessions', async () => {
    await addInstalledLibrary('sid-A', 'https://a.excalidrawlib')
    await addInstalledLibrary('sid-B', 'https://b.excalidrawlib')
    const a = await loadInstalledLibraries('sid-A')
    const b = await loadInstalledLibraries('sid-B')
    expect(a.urls).toEqual(['https://a.excalidrawlib'])
    expect(b.urls).toEqual(['https://b.excalidrawlib'])
  })

  it('does not overwrite corrupt existing files when addInstalledLibrary runs', async () => {
    const path = join(tempDir, 'sid-add-corrupt', '.libraries.json')
    await mkdir(join(tempDir, 'sid-add-corrupt'), { recursive: true })
    await writeFile(path, 'not-json')

    await expect(
      addInstalledLibrary('sid-add-corrupt', 'https://libraries.excalidraw.com/libraries/foo.excalidrawlib'),
    ).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      code: 'corrupt_stored_data',
    })
    await expect(readFile(path, 'utf-8')).resolves.toBe('not-json')
  })

  it('does not overwrite corrupt existing files when removeInstalledLibrary runs', async () => {
    const path = join(tempDir, 'sid-remove-corrupt', '.libraries.json')
    await mkdir(join(tempDir, 'sid-remove-corrupt'), { recursive: true })
    await writeFile(path, '{"urls":')

    await expect(
      removeInstalledLibrary('sid-remove-corrupt', 'https://libraries.excalidraw.com/libraries/foo.excalidrawlib'),
    ).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      code: 'corrupt_stored_data',
    })
    await expect(readFile(path, 'utf-8')).resolves.toBe('{"urls":')
  })
})
