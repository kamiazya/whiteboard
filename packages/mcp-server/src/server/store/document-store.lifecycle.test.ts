import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  isWorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Swap DATA_DIR to a temp directory through vi.mock.
let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

// Use dynamic import so it runs after the mock is resolved.
const { saveDocument, loadDocument, listDocuments, renameDocumentPath, ConflictError } =
  await import('./document-store.js')
const { getDefaultServerDeps } = await import('../../di/default-server-deps.js')
const { wbDocumentDelete } = await import('@kamiazya/whiteboard-server-core')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

async function setupIsolatedDb(): Promise<void> {
  handle = await createIsolatedDb({ dataDir: tempDir })
}

async function teardownIsolatedDb(): Promise<void> {
  await handle.dispose()
}

// Split from document-store.test.ts by topic (document lifecycle: delete +
// rename); the vi.mock + awaited-import harness is per-file by necessity.

// The local helper is the ROUTE's translation, written once here rather than
// at each call below: this surface addresses a document by path and answers
// `false` for one that does not exist, where the operation addresses it by
// the id the index assigned and throws. Everything else the cases assert is
// unchanged, which is the point — the implementation moved, the behaviour
// did not.
async function deleteDocument(workspaceId: string, path: string): Promise<boolean> {
  const deps = await getDefaultServerDeps()
  // The tree index throws for an unknown WORKSPACE where the retired SQL
  // index answered null; the route's translation treats both as absent.
  const entry = await deps.documentIndex
    .resolveDocument({ workspaceId, path })
    .catch((err: unknown) => {
      if (isWorkspaceNotFoundError(err)) return null
      throw err
    })
  if (entry === null) return false
  await wbDocumentDelete(deps, { workspaceId, documentId: entry.documentId })
  return true
}

describe('deleting a document', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-delete-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  // The MCP surface already refuses this, and for a stated reason: deletion
  // is the operation with nothing to undo it, so the caller has to name what
  // it is destroying. The HTTP surface deleting the same document silently
  // strands every child under a prefix nothing owns.
  it('refuses to delete a document that still has descendants', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a/child', new LoroDoc())

    await expect(deleteDocument('session1', 'a')).rejects.toThrow(DocumentHasDescendantsError)

    const paths = (await listDocuments('session1')).map((c) => c.path).sort()
    expect(paths).toEqual(['a', 'a/child'])
  })

  it('deletes a document whose name merely prefixes a sibling', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a-sibling', new LoroDoc())

    await expect(deleteDocument('session1', 'a')).resolves.toBe(true)

    expect((await listDocuments('session1')).map((c) => c.path)).toEqual(['a-sibling'])
  })

  it('removes the tree entry, deletes branches/versions rows explicitly, and unlinks the version thumbnail PNGs, leaving the workspace row and a sibling canvas untouched', async () => {
    const { getDb } = await import('./db/index.js')
    const { createBranch } = await import('./branches-store.js')
    const { stat } = await import('node:fs/promises')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')

    const doc = new LoroDoc()
    await saveDocument('session1', 'canvas-a', doc)
    await saveDocument('session1', 'canvas-b', doc)
    const store = new FileVersionStore()
    const version = await store.save('session1', 'canvas-a', doc, { auto: true })
    await store.saveThumbnail('session1', 'canvas-a', version.id, new Uint8Array([1, 2, 3]))
    await createBranch('session1', 'canvas-a', { name: 'feature' })

    const db = await getDb(tempDir)
    const { resolveDocumentIdAtPath } = await import('./document-store.js')
    const documentId = await resolveDocumentIdAtPath('session1', 'canvas-a')
    if (documentId === null) throw new Error('document missing from the tree')
    const libsqlStore = new LibsqlDocumentStore(db)

    const thumbPath = join(tempDir, 'blobs', 'session1', 'versions', `${version.id}.png`)
    await expect(stat(thumbPath)).resolves.toBeDefined()

    await expect(deleteDocument('session1', 'canvas-a')).resolves.toBe(true)

    const branchesAfter = await db
      .selectFrom('branches')
      .selectAll()
      .where('documentId', '=', documentId)
      .execute()
    expect(branchesAfter).toEqual([])
    const versionsAfter = await db
      .selectFrom('versions')
      .selectAll()
      .where('documentId', '=', documentId)
      .execute()
    expect(versionsAfter).toEqual([])

    // Content now lives in the workspace record: the tree node is gone and
    // the bytes were EVACUATED into the trash, not destroyed.
    const { DocumentStoreWorkspaceDocs } = await import('@kamiazya/whiteboard-workspace-index')
    const { resolveWorkspaceDocumentById, readTrashEntries } = await import(
      '@kamiazya/whiteboard-loro-adapter'
    )
    const stored = await new DocumentStoreWorkspaceDocs(libsqlStore).open('session1')
    expect(stored).not.toBeNull()
    expect(resolveWorkspaceDocumentById(stored!, documentId)).toBeNull()
    expect(readTrashEntries(stored!).map((t) => t.documentId)).toContain(documentId)
    await expect(stat(thumbPath)).rejects.toThrow()

    const wsRow = await db
      .selectFrom('workspaces')
      .select(['id'])
      .where('id', '=', 'session1')
      .executeTakeFirst()
    expect(wsRow).toBeDefined()
    // The sibling lives in the tree (documents rows retired with the
    // dual-plane collapse), so "untouched" is a listing fact.
    expect((await listDocuments('session1')).map((c) => c.path)).toEqual(['canvas-b'])
  })

  // The defect this closes: wb_document_delete removed the index row and the
  // Libsql bytes and stopped there, so a document an agent deleted left its
  // thumbnails, its blob and a cached doc instance behind — while the same
  // document deleted through the HTTP route did not. Both paths now run the
  // same teardown, and this asserts on the FILES, not on the tool answering
  // { deleted: true }, which it did throughout the whole defect.
  it('leaves the same state when the delete comes through wb_document_delete as through the HTTP path', async () => {
    const { getDb } = await import('./db/index.js')
    const { stat } = await import('node:fs/promises')
    const { wbDocumentDelete } = await import('@kamiazya/whiteboard-server-core')
    const { LoroWorkspaceDocumentIndex } = await import('@kamiazya/whiteboard-workspace-index')
    const { FsBlobStore } = await import('./fs/fs-blob-store.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { peekDoc } = await import('./doc-cache.js')
    const { cacheBackedWorkspaceDocs, documentTeardown, resolveDocumentIdAtPath } = await import(
      './document-store.js'
    )

    const doc = new LoroDoc()
    await saveDocument('session1', 'agent-deleted', doc)
    const store = new FileVersionStore()
    const version = await store.save('session1', 'agent-deleted', doc, { auto: true })
    await store.saveThumbnail('session1', 'agent-deleted', version.id, new Uint8Array([1, 2, 3]))
    // Populate the doc cache the way a read would, so eviction has something
    // to evict — otherwise this half of the assertion passes vacuously.
    // getDoc, not loadDocument: only the former goes through the LRU.
    const { getDoc } = await import('./document-store.js')
    await getDoc('session1', 'agent-deleted')
    expect(peekDoc('session1', 'agent-deleted')).toBeDefined()

    const db = await getDb(tempDir)
    const documentId = await resolveDocumentIdAtPath('session1', 'agent-deleted')
    expect(documentId).not.toBeNull()
    if (documentId === null) throw new Error('unreachable')
    const thumbPath = join(tempDir, 'blobs', 'session1', 'versions', `${version.id}.png`)
    await expect(stat(thumbPath)).resolves.toBeDefined()

    await wbDocumentDelete(
      {
        documentStore: new LibsqlDocumentStore(db),
        blobStore: {} as never,
        documentIndex: new LoroWorkspaceDocumentIndex(
          cacheBackedWorkspaceDocs(),
          new FsBlobStore(join(tempDir, 'blobs')),
        ),
        documentTeardown,
      },
      { workspaceId: 'session1', documentId },
    )

    await expect(stat(thumbPath)).rejects.toThrow()
    expect(peekDoc('session1', 'agent-deleted')).toBeUndefined()
    expect(await resolveDocumentIdAtPath('session1', 'agent-deleted')).toBeNull()
  })

  it('returns false for a missing canvas without throwing; deleting the same canvas twice returns true then false', async () => {
    await expect(deleteDocument('session1', 'ghost')).resolves.toBe(false)

    await saveDocument('session1', 'once', new LoroDoc())
    await expect(deleteDocument('session1', 'once')).resolves.toBe(true)
    await expect(deleteDocument('session1', 'once')).resolves.toBe(false)
  })

  it('deletes a canvas that never had an FS blob (nothing writes one post-collapse)', async () => {
    // saveDocument never writes an FS blob — content lives entirely in the
    // workspace record's Libsql-backed bytes.
    await saveDocument('session1', 'row-only', new LoroDoc())

    await expect(deleteDocument('session1', 'row-only')).resolves.toBe(true)
    expect(
      await (await import('./document-store.js')).resolveDocumentIdAtPath('session1', 'row-only'),
    ).toBeNull()
  })
})

describe('renameDocumentPath', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-rename-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('moves only the path: branches, version rows and the Libsql snapshot stay byte-identical and keyed to the same documentId', async () => {
    const { getDb } = await import('./db/index.js')
    const { createBranch, loadDocumentBranches } = await import('./branches-store.js')

    const doc = new LoroDoc()
    await saveDocument('session1', 'a', doc)
    await createBranch('session1', 'a', { name: 'feature' })
    const store = new FileVersionStore()
    const version = await store.save('session1', 'a', doc, { auto: true })

    const db = await getDb(tempDir)
    const beforeId = await (await import('./document-store.js')).resolveDocumentIdAtPath(
      'session1',
      'a',
    )
    if (beforeId === null) throw new Error('document missing from the tree')
    const before = { id: beforeId }
    const documentId = before.id
    const contentBefore = (await loadDocument('session1', 'a')).toJSON()

    await expect(renameDocumentPath('session1', 'a', 'b')).resolves.toEqual({ documentId })

    const list = await listDocuments('session1')
    expect(list.map((c) => c.path)).toEqual(['b'])

    const afterId = await (await import('./document-store.js')).resolveDocumentIdAtPath(
      'session1',
      'b',
    )
    if (afterId === null) throw new Error('document missing from the tree')
    const after = { id: afterId }
    expect(after.id).toBe(documentId)

    const versionsAfter = await db
      .selectFrom('versions')
      .selectAll()
      .where('documentId', '=', documentId)
      .execute()
    expect(versionsAfter.map((v) => v.id)).toEqual([version.id])

    // Content is untouched by the move — same documentId, same value.
    expect((await loadDocument('session1', 'b')).toJSON()).toEqual(contentBefore)

    // Branches survive the move and resolve under the new path. This used to
    // read the `branches` rows as well; branches live on the workspace
    // record now, and the record is keyed by documentId, so the path change
    // cannot reach them — which is the property, stated once through the
    // reader everything else uses.
    const branches = await loadDocumentBranches('session1', 'b')
    expect(branches.branches.map((b) => b.name).sort()).toEqual(['feature', 'main'])
  })

  it('returns null (never throws) for a missing source canvas', async () => {
    await expect(renameDocumentPath('session1', 'ghost', 'somewhere')).resolves.toBeNull()
  })

  it('throws ConflictError for an already-taken target path and mutates neither canvas', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'b', new LoroDoc())

    await expect(renameDocumentPath('session1', 'a', 'b')).rejects.toThrow(ConflictError)

    const list = await listDocuments('session1')
    expect(list.map((c) => c.path).sort()).toEqual(['a', 'b'])
  })

  it('throws the path validator error for an invalid target path', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await expect(renameDocumentPath('session1', 'a', '../evil')).rejects.toThrow()
  })

  it('rename to the SAME path is a no-op success, returning the existing documentId', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    const { getDb } = await import('./db/index.js')
    const _db = await getDb(tempDir)
    const beforeId = await (await import('./document-store.js')).resolveDocumentIdAtPath(
      'session1',
      'a',
    )
    if (beforeId === null) throw new Error('document missing from the tree')
    const before = { id: beforeId }

    await expect(renameDocumentPath('session1', 'a', 'a')).resolves.toEqual({
      documentId: before.id,
    })

    const list = await listDocuments('session1')
    expect(list.map((c) => c.path)).toEqual(['a'])
  })

  // A path IS the hierarchy, so renaming one carries everything under it.
  // Moving only the named row leaves its children addressed below a prefix
  // no document owns — reachable by nothing the UI can show, and produced by
  // the ordinary act of renaming a group.
  it('carries every descendant with the renamed path', async () => {
    await saveDocument('session1', 'design', new LoroDoc())
    await saveDocument('session1', 'design/login', new LoroDoc())
    await saveDocument('session1', 'design/deep/notes', new LoroDoc())
    await saveDocument('session1', 'designs-elsewhere', new LoroDoc())

    await renameDocumentPath('session1', 'design', 'product')

    const paths = (await listDocuments('session1')).map((c) => c.path).sort()
    expect(paths).toEqual(['designs-elsewhere', 'product', 'product/deep/notes', 'product/login'])
  })

  // The prefix test above would pass with a blind string replace; this one
  // fails unless the rewrite is anchored at a segment boundary.
  it('does not carry a sibling that merely shares the name as a prefix', async () => {
    await saveDocument('session1', 'design', new LoroDoc())
    await saveDocument('session1', 'design-system', new LoroDoc())

    await renameDocumentPath('session1', 'design', 'product')

    const paths = (await listDocuments('session1')).map((c) => c.path).sort()
    expect(paths).toEqual(['design-system', 'product'])
  })

  // The one rule `planSubtreeMove` deliberately does NOT enforce, so each
  // caller has to. Without it the depth-ordered write — correct for the
  // upward move it was written for — is inverted, and the shallow row lands
  // on a path its own descendant has not vacated yet.
  it('refuses to move a document inside itself rather than raising a raw constraint error', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a/x', new LoroDoc())

    await expect(renameDocumentPath('session1', 'a', 'a/x')).rejects.toThrow(
      DocumentMoveIntoSelfError,
    )

    const paths = (await listDocuments('session1')).map((c) => c.path).sort()
    expect(paths).toEqual(['a', 'a/x'])
  })

  it('refuses to nest a document inside itself even when the destination is free', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a/b', new LoroDoc())

    await expect(renameDocumentPath('session1', 'a', 'a/nested')).rejects.toThrow(
      DocumentMoveIntoSelfError,
    )

    const paths = (await listDocuments('session1')).map((c) => c.path).sort()
    expect(paths).toEqual(['a', 'a/b'])
  })

  it('rejects a rename that would collide with an existing descendant path', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a/x', new LoroDoc())
    await saveDocument('session1', 'c/x', new LoroDoc())

    // `a` -> `c` is free at the top, and still collides: `a/x` would land on
    // the occupied `c/x`.
    await expect(renameDocumentPath('session1', 'a', 'c')).rejects.toThrow(ConflictError)

    const paths = (await listDocuments('session1')).map((c) => c.path).sort()
    expect(paths).toEqual(['a', 'a/x', 'c/x'])
  })

  it('evicts every moved path from the cache, not only the two named ones', async () => {
    const { peekDoc, clearCache } = await import('./doc-cache.js')
    const { getDoc } = await import('./document-store.js')
    clearCache()
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a/child', new LoroDoc())
    await getDoc('session1', 'a/child')
    expect(peekDoc('session1', 'a/child')).not.toBeUndefined()

    await renameDocumentPath('session1', 'a', 'b')

    // A stale instance cached under the old child path would be resurrected
    // by the next read through it, shadowing the moved document.
    expect(peekDoc('session1', 'a/child')).toBeUndefined()
  })

  it('evicts the old cache key so a subsequent getDoc under the old path misses the cache', async () => {
    const { peekDoc, clearCache } = await import('./doc-cache.js')
    const { getDoc } = await import('./document-store.js')
    clearCache()
    try {
      await saveDocument('session1', 'a', new LoroDoc())
      await getDoc('session1', 'a')
      expect(peekDoc('session1', 'a')).toBeDefined()

      await renameDocumentPath('session1', 'a', 'b')
      expect(peekDoc('session1', 'a')).toBeUndefined()
    } finally {
      clearCache()
    }
  })

  it('evicts a phantom doc-cache entry already sitting at the destination path, so the renamed content is not overwritten', async () => {
    const { peekDoc, clearCache } = await import('./doc-cache.js')
    const { getDoc } = await import('./document-store.js')
    clearCache()
    try {
      // Write real content under 'a'.
      const doc = new LoroDoc()
      doc.getText('content').insert(0, 'real content')
      doc.commit()
      await saveDocument('session1', 'a', doc)

      // Simulate a WS connect (or update route) against a not-yet-created
      // path 'b': getDoc() lazily caches an empty in-memory doc for it
      // even though there is no DB row yet.
      await getDoc('session1', 'b')
      expect(peekDoc('session1', 'b')).toBeDefined()

      await renameDocumentPath('session1', 'a', 'b')

      // The stale phantom doc must not still shadow the just-renamed
      // canvas's real content at the destination path.
      expect(peekDoc('session1', 'b')).toBeUndefined()

      const reloaded = await getDoc('session1', 'b')
      expect(reloaded.getText('content').toString()).toBe('real content')
    } finally {
      clearCache()
    }
  })
})
