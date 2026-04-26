import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
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

const { loadWorkspaceNames, setWorkspaceName, setCanvasName, setCanvasPinned } = await import(
  './names-store.js'
)

describe('names-store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'names-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty WorkspaceNames for an uninitialized session', async () => {
    const names = await loadWorkspaceNames('sess-1')
    expect(names).toEqual({ canvases: {}, pinned: [] })
  })

  it('setWorkspaceName persists the workspace name and loadWorkspaceNames returns it', async () => {
    await setWorkspaceName('sess-1', 'My Workspace')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.workspace).toBe('My Workspace')
    expect(names.canvases).toEqual({})
  })

  it('setCanvasName stores names per slug', async () => {
    await setCanvasName('sess-1', 'arch/overview', 'Architecture Overview')
    await setCanvasName('sess-1', 'notes/meeting', 'Team meeting notes')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.canvases['arch/overview']).toBe('Architecture Overview')
    expect(names.canvases['notes/meeting']).toBe('Team meeting notes')
  })

  it('setWorkspaceName deletes workspace on empty string input', async () => {
    await setWorkspaceName('sess-1', 'Keep it')
    await setWorkspaceName('sess-1', '')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.workspace).toBeUndefined()
  })

  it('setCanvasName deletes the slug entry on empty string input', async () => {
    await setCanvasName('sess-1', 'a', 'Alpha')
    await setCanvasName('sess-1', 'b', 'Beta')
    await setCanvasName('sess-1', 'a', '')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.canvases).toEqual({ b: 'Beta' })
  })

  it('trims leading and trailing whitespace', async () => {
    await setCanvasName('sess-1', 'slug', '   spaced   ')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.canvases.slug).toBe('spaced')
  })

  it('treats all-whitespace values as empty and deletes them', async () => {
    await setCanvasName('sess-1', 'slug', 'Initial')
    await setCanvasName('sess-1', 'slug', '   \t  \n ')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.canvases.slug).toBeUndefined()
  })

  it('returns a corruption error for invalid JSON instead of falling back to empty WorkspaceNames', async () => {
    await mkdir(join(tempDir, 'sess-1'), { recursive: true })
    await writeFile(join(tempDir, 'sess-1', '.names.json'), 'not-json{{{')

    await expect(loadWorkspaceNames('sess-1')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      code: 'corrupt_stored_data',
    })
  })

  it('updates workspace and canvases independently without overwriting each other', async () => {
    await setCanvasName('sess-1', 'c1', 'Canvas 1')
    await setWorkspaceName('sess-1', 'My WS')
    await setCanvasName('sess-1', 'c2', 'Canvas 2')

    const names = await loadWorkspaceNames('sess-1')
    expect(names.workspace).toBe('My WS')
    expect(names.canvases).toEqual({ c1: 'Canvas 1', c2: 'Canvas 2' })
  })

  it('setCanvasPinned(true) appends to pinned and is idempotent', async () => {
    let names = await setCanvasPinned('sess-1', 'c1', true)
    expect(names.pinned).toEqual(['c1'])
    names = await setCanvasPinned('sess-1', 'c2', true)
    expect(names.pinned).toEqual(['c1', 'c2'])
    // Re-pinning is a no-op and preserves order.
    names = await setCanvasPinned('sess-1', 'c1', true)
    expect(names.pinned).toEqual(['c1', 'c2'])
  })

  it('setCanvasPinned(false) removes from the array and is a no-op for missing slugs', async () => {
    await setCanvasPinned('sess-1', 'c1', true)
    await setCanvasPinned('sess-1', 'c2', true)
    let names = await setCanvasPinned('sess-1', 'c1', false)
    expect(names.pinned).toEqual(['c2'])
    // Unpinning a missing slug is a no-op.
    names = await setCanvasPinned('sess-1', 'nope', false)
    expect(names.pinned).toEqual(['c2'])
  })

  it('keeps pinned independent from name and workspace changes', async () => {
    await setCanvasPinned('sess-1', 'c1', true)
    await setWorkspaceName('sess-1', 'WS')
    await setCanvasName('sess-1', 'c1', 'Canvas 1')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.pinned).toEqual(['c1'])
    expect(names.workspace).toBe('WS')
    expect(names.canvases).toEqual({ c1: 'Canvas 1' })
  })

  it('returns a corruption error for schema-mismatched .names.json files', async () => {
    await mkdir(join(tempDir, 'sess-2'), { recursive: true })
    await writeFile(
      join(tempDir, 'sess-2', '.names.json'),
      JSON.stringify({ workspace: 'WS', canvases: [], pinned: ['c1'] }),
    )

    await expect(loadWorkspaceNames('sess-2')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      code: 'corrupt_stored_data',
    })
  })

  it('setWorkspaceName does not overwrite corrupt state', async () => {
    const path = join(tempDir, 'sess-3', '.names.json')
    await mkdir(join(tempDir, 'sess-3'), { recursive: true })
    await writeFile(path, 'not-json')

    await expect(setWorkspaceName('sess-3', 'Renamed')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      code: 'corrupt_stored_data',
    })
    await expect(readFile(path, 'utf-8')).resolves.toBe('not-json')
  })

  it('setCanvasName does not overwrite corrupt state', async () => {
    const path = join(tempDir, 'sess-4', '.names.json')
    await mkdir(join(tempDir, 'sess-4'), { recursive: true })
    await writeFile(path, '{"workspace":"WS","canvases":[],"pinned":[]}')

    await expect(setCanvasName('sess-4', 'canvas-a', 'Canvas A')).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      code: 'corrupt_stored_data',
    })
    await expect(readFile(path, 'utf-8')).resolves.toBe('{"workspace":"WS","canvases":[],"pinned":[]}')
  })

  it('setCanvasPinned does not overwrite corrupt state', async () => {
    const path = join(tempDir, 'sess-5', '.names.json')
    await mkdir(join(tempDir, 'sess-5'), { recursive: true })
    await writeFile(path, '{"workspace":"WS","canvases":{},"pinned":[1]}')

    await expect(setCanvasPinned('sess-5', 'canvas-a', true)).rejects.toMatchObject({
      name: 'CorruptStoredDataError',
      code: 'corrupt_stored_data',
    })
    await expect(readFile(path, 'utf-8')).resolves.toBe('{"workspace":"WS","canvases":{},"pinned":[1]}')
  })
})
