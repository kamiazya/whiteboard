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

// Pass-through, except that a test can be told when the path check before the
// write lock has finished: the one point after which a rename can race a write.
let afterPathCheck: (() => void) | undefined
vi.mock('./document-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./document-store.js')>()
  return {
    ...actual,
    requireDocumentAtPath: async (...args: Parameters<typeof actual.requireDocumentAtPath>) => {
      const documentId = await actual.requireDocumentAtPath(...args)
      afterPathCheck?.()
      return documentId
    },
  }
})

const { loadWorkspaceNames, setWorkspaceName, setDocumentDisplayName, setDocumentPinned } =
  await import('./names-store.js')
const { saveDocument } = await import('./document-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { LoroDoc } = await import('loro-crdt')

// Metadata writers refuse a path with no document, so every test that names
// one seeds it first — the shape production always has.
async function seedDocuments(workspaceId: string, paths: readonly string[]) {
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

  // Pin state is shared CRDT state (dual-plane collapse): the row write
  // keeps serving today's reads, and the workspace record's pinned list is
  // what every replica converges on.
  it('mirrors pin and unpin into the workspace record pinned list', async () => {
    const { openWorkspaceDocIfStored, resolveDocumentIdAtPath } = await import(
      './document-store.js'
    )
    const { readPinnedDocumentIds } = await import('@kamiazya/whiteboard-loro-adapter')
    const idOf = async (path: string) => {
      const id = await resolveDocumentIdAtPath('sess-1', path)
      if (id === null) throw new Error(`no document at ${path}`)
      return id
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

  it('setWorkspaceName persists the workspace name and loadWorkspaceNames returns it', async () => {
    await setWorkspaceName('sess-1', 'My Workspace')
    const names = await loadWorkspaceNames('sess-1')
    expect(names.workspace).toBe('My Workspace')
    expect(names.documents).toEqual({})
  })

  // Pins that PUT /api/workspaces/:id/name (setWorkspaceName) writes the
  // SAME `workspaces.displayName` column GET /api/workspaces
  // (workspaceRegistry().listWorkspaces()) serves — one column, two routes.
  it('setWorkspaceName writes the column workspaceRegistry().listWorkspaces() serves', async () => {
    const { workspaceRegistry } = await import('./document-store.js')
    await setWorkspaceName('sess-1', 'My Workspace')
    const rows = await workspaceRegistry().listWorkspaces()
    expect(rows.find((r) => r.workspaceId === 'sess-1')).toEqual({
      workspaceId: 'sess-1',
      displayName: 'My Workspace',
    })
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

  // `loadWorkspaceNames` reads a blank workspace name and an absent one alike, so the
  // column is the only place a stored blank shows. Every registry listing reads it.
  describe('workspace display name column', () => {
    const storedName = async (): Promise<string | null | undefined> =>
      (
        await handle.db
          .selectFrom('workspaces')
          .select('displayName')
          .where('id', '=', 'sess-1')
          .executeTakeFirst()
      )?.displayName

    it.each([
      ['  Padded name \t', 'Padded name'],
      ['Plain', 'Plain'],
    ])('stores %j as %j', async (input, stored) => {
      await setWorkspaceName('sess-1', input)
      expect(await storedName()).toBe(stored)
    })

    it.each([
      [''],
      ['   '],
      ['\t\n '],
    ])('stores %j as null, not as a blank string', async (blank) => {
      await setWorkspaceName('sess-1', 'Keep it')
      await setWorkspaceName('sess-1', blank)
      expect(await storedName()).toBeNull()
    })
  })

  describe('document display name in the workspace record', () => {
    async function nodeName(path: string): Promise<string | undefined> {
      const { openWorkspaceDocIfStored } = await import('./document-store.js')
      const { resolveWorkspaceDocument } = await import('@kamiazya/whiteboard-loro-adapter')
      const doc = await openWorkspaceDocIfStored('sess-1')
      if (doc === null) throw new Error('no workspace record')
      const entry = resolveWorkspaceDocument(doc, path)
      if (entry === null) throw new Error(`no document at ${path}`)
      return entry.name
    }

    it.each([
      [''],
      ['   '],
      ['\t\n '],
    ])('clears the stored name for %j and leaves the document in place', async (blank) => {
      await setDocumentDisplayName('sess-1', 'path', 'Initial')
      await setDocumentDisplayName('sess-1', 'path', blank)
      expect(await nodeName('path')).toBeUndefined()
    })

    // The path was checked before the lock, so a writer that waited for it can find
    // the document gone; the name of a document that no longer exists is not an error.
    it('writes nothing, and does not fail, for a document removed while it waited for the lock', async () => {
      const { openWorkspaceDocIfStored, saveWorkspaceDoc, resolveDocumentIdAtPath } = await import(
        './document-store.js'
      )
      const { deleteWorkspaceDocument } = await import('@kamiazya/whiteboard-loro-adapter')
      const { withWorkspaceWriteLock } = await import('./workspace-lock.js')
      const documentId = await resolveDocumentIdAtPath('sess-1', 'path')
      if (documentId === null) throw new Error('no document at path')

      let releaseHolder: () => void = () => {}
      const holderMayFinish = new Promise<void>((resolve) => {
        releaseHolder = resolve
      })
      let pathChecked: () => void = () => {}
      const pathCheckedSignal = new Promise<void>((resolve) => {
        pathChecked = resolve
      })
      afterPathCheck = pathChecked
      try {
        const holder = withWorkspaceWriteLock('sess-1', async () => {
          await holderMayFinish
          const doc = await openWorkspaceDocIfStored('sess-1')
          if (doc === null) throw new Error('no workspace record')
          deleteWorkspaceDocument(doc, { documentId })
          await saveWorkspaceDoc('sess-1', doc)
        })
        const rename = setDocumentDisplayName('sess-1', 'path', 'Too late')
        await pathCheckedSignal
        releaseHolder()
        await holder
        const names = await rename
        expect(names.documents).toEqual({})
      } finally {
        afterPathCheck = undefined
      }
    })

    it('stores the trimmed name', async () => {
      await setDocumentDisplayName('sess-1', 'path', '  Padded \t')
      expect(await nodeName('path')).toBe('Padded')
    })
  })

  // The pinned list holds document ids and the tree is edited by replicas that know
  // nothing of it, so an id can outlive its document; it names no path to report.
  it('omits a pinned document that has left the tree, keeping the others in order', async () => {
    const { openWorkspaceDocIfStored, saveWorkspaceDoc, resolveDocumentIdAtPath } = await import(
      './document-store.js'
    )
    const { deleteWorkspaceDocument } = await import('@kamiazya/whiteboard-loro-adapter')
    await setDocumentPinned('sess-1', 'a', true)
    await setDocumentPinned('sess-1', 'b', true)
    await setDocumentPinned('sess-1', 'c1', true)
    const gone = await resolveDocumentIdAtPath('sess-1', 'b')
    const doc = await openWorkspaceDocIfStored('sess-1')
    if (doc === null || gone === null) throw new Error('fixture missing')
    deleteWorkspaceDocument(doc, { documentId: gone })
    await saveWorkspaceDoc('sess-1', doc)

    expect((await loadWorkspaceNames('sess-1')).pinned).toEqual(['a', 'c1'])
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
