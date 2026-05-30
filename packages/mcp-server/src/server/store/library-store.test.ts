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
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

describe('library-store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-lib-store-test-'))
    handle = await createIsolatedDb({ dataDir: tempDir })
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty urls for an uninitialized session', async () => {
    const libs = await loadInstalledLibraries('sid-new')
    expect(libs).toEqual({ urls: [] })
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

})
