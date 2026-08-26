import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp',
  REPO_ROOT: '/tmp',
}))

const { loadWorkspaceNames, setWorkspaceName, setDocumentDisplayName, setDocumentPinned } =
  await import('./names-store.js')
const { saveDocument } = await import('./document-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { LoroDoc } = await import('loro-crdt')

// Metadata writers refuse a path with no document, so every test that names
// one seeds it first — the shape production always has.
async function seedDocuments(workspaceId, paths) {
  for (const path of paths) {
    await saveDocument(workspaceId, path, new LoroDoc(), { kind: 'spatial' })
  }
}

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

describe('names-store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'names-test-'))
    handle = await createIsolatedDb({ dataDir: tempDir })
    await seedDocuments('sess-1', ['a', 'b', 'c1', 'c2', 'path', 'notes/meeting', 'arch/overview'])
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty WorkspaceNames for an uninitialized session', async () => {
    const names = await loadWorkspaceNames('sess-1')
    expect(names).toEqual({ documents: {}, pinned: [] })
  })

  // Metadata writes must not CREATE documents: a minted row here has no kind
  // and no workspace-tree node — a corrupt state the boot fold deletes and
  // the listing contract rejects. Creating documents is saveDocument /
  // createDocument's job alone.
  it('setDocumentDisplayName refuses a path with no document instead of minting a phantom row', async () => {
    await expect(setDocumentDisplayName('sess-1', 'never-created', 'Name')).rejects.toThrow(
      /no document/i,
    )
  })

  it('setDocumentPinned refuses a path with no document instead of minting a phantom row', async () => {
    await expect(setDocumentPinned('sess-1', 'never-created', true)).rejects.toThrow(/no document/i)
  })

  // Pin state is shared CRDT state (dual-plane collapse S4b): the row write
  // keeps serving today's reads, and the workspace record's pinned list is
  // what every replica converges on.
  it('mirrors pin and unpin into the workspace record pinned list', async () => {
    const { openWorkspaceDocIfStored } = await import('./document-store.js')
    const { readPinnedDocumentIds } = await import('@kamiazya/whiteboard-loro-adapter')
    const { getDb } = await import('./db/index.js')
    const db = await getDb(tempDir)
    const idOf = async (path: string) => {
      const row = await db
        .selectFrom('documents')
        .select(['id'])
        .where('workspaceId', '=', 'sess-1')
        .where('path', '=', path)
        .executeTakeFirstOrThrow()
      return row.id
    }

    await setDocumentPinned('sess-1', 'b', true)
    await setDocumentPinned('sess-1', 'a', true)
    const doc = await openWorkspaceDocIfStored('sess-1')
    expect(doc).not.toBeNull()
    if (doc === null) throw new Error('unreachable')
    expect(readPinnedDocumentIds(doc)).toEqual([await idOf('b'), await idOf('a')])

    await setDocumentPinned('sess-1', 'b', false)
    expect(readPinnedDocumentIds(doc)).toEqual([await idOf('a')])
  })

  // S7: reads answer from the workspace record, not the rows — skewing the
  // rows behind the tree's back must not change what the listing says.
  it('loadWorkspaceNames answers names and pins from the tree, not the rows', async () => {
    const { getDb } = await import('./db/index.js')
    await setDocumentDisplayName('sess-1', 'a', 'Tree name')
    await setDocumentPinned('sess-1', 'b', true)
    const db = await getDb(tempDir)
    await db
      .updateTable('documents')
      .set({ displayName: 'Rows-only name', isPinned: 0, pinOrder: null })
      .where('workspaceId', '=', 'sess-1')
      .execute()

    const names = await loadWorkspaceNames('sess-1')
    expect(names.documents.a).toBe('Tree name')
    expect(names.pinned).toEqual(['b'])
  })

  it('setWorkspaceName persists the workspace name and loadWorkspaceNames returns it', async () => {
    await setWorkspaceName('sess-1', 'My Workspace')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.workspace).toBe('My Workspace')
    expect(names.documents).toEqual({})
  })

  it('setDocumentDisplayName stores names per path', async () => {
    await setDocumentDisplayName('sess-1', 'arch/overview', 'Architecture Overview')
    await setDocumentDisplayName('sess-1', 'notes/meeting', 'Team meeting notes')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.documents['arch/overview']).toBe('Architecture Overview')
    expect(names.documents['notes/meeting']).toBe('Team meeting notes')
  })

  it('setWorkspaceName deletes workspace on empty string input', async () => {
    await setWorkspaceName('sess-1', 'Keep it')
    await setWorkspaceName('sess-1', '')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.workspace).toBeUndefined()
  })

  it('setDocumentDisplayName deletes the path entry on empty string input', async () => {
    await setDocumentDisplayName('sess-1', 'a', 'Alpha')
    await setDocumentDisplayName('sess-1', 'b', 'Beta')
    await setDocumentDisplayName('sess-1', 'a', '')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.documents).toEqual({ b: 'Beta' })
  })

  it('trims leading and trailing whitespace', async () => {
    await setDocumentDisplayName('sess-1', 'path', '   spaced   ')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.documents.path).toBe('spaced')
  })

  it('treats all-whitespace values as empty and deletes them', async () => {
    await setDocumentDisplayName('sess-1', 'path', 'Initial')
    await setDocumentDisplayName('sess-1', 'path', '   \t  \n ')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.documents.path).toBeUndefined()
  })

  it('updates workspace and documents independently without overwriting each other', async () => {
    await setDocumentDisplayName('sess-1', 'c1', 'Canvas 1')
    await setWorkspaceName('sess-1', 'My WS')
    await setDocumentDisplayName('sess-1', 'c2', 'Canvas 2')

    const names = await loadWorkspaceNames('sess-1')
    expect(names.workspace).toBe('My WS')
    expect(names.documents).toEqual({ c1: 'Canvas 1', c2: 'Canvas 2' })
  })

  it('setDocumentPinned(true) appends to pinned and is idempotent', async () => {
    let names = await setDocumentPinned('sess-1', 'c1', true)
    expect(names.pinned).toEqual(['c1'])
    names = await setDocumentPinned('sess-1', 'c2', true)
    expect(names.pinned).toEqual(['c1', 'c2'])
    // Re-pinning is a no-op and preserves order.
    names = await setDocumentPinned('sess-1', 'c1', true)
    expect(names.pinned).toEqual(['c1', 'c2'])
  })

  it('setDocumentPinned(false) removes from the array and is a no-op for missing paths', async () => {
    await setDocumentPinned('sess-1', 'c1', true)
    await setDocumentPinned('sess-1', 'c2', true)
    const names = await setDocumentPinned('sess-1', 'c1', false)
    expect(names.pinned).toEqual(['c2'])
    // Unpinning a path with no document is the caller naming a document
    // that does not exist — refused like every other metadata write.
    await expect(setDocumentPinned('sess-1', 'nope', false)).rejects.toThrow(/no document/i)
  })

  it('keeps pinned independent from name and workspace changes', async () => {
    await setDocumentPinned('sess-1', 'c1', true)
    await setWorkspaceName('sess-1', 'WS')
    await setDocumentDisplayName('sess-1', 'c1', 'Canvas 1')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.pinned).toEqual(['c1'])
    expect(names.workspace).toBe('WS')
    expect(names.documents).toEqual({ c1: 'Canvas 1' })
  })
})
