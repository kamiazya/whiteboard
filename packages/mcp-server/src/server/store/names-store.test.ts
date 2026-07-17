import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp',
  REPO_ROOT: '/tmp',
}))

const { loadWorkspaceNames, setWorkspaceName, setCanvasName, setCanvasPinned } = await import(
  './names-store.js'
)
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

describe('names-store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'names-test-'))
    handle = await createIsolatedDb({ dataDir: tempDir })
  })

  afterEach(async () => {
    await handle.dispose()
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
})
