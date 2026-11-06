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
const { resolveTestServerDeps } = await import('../routes/_test-helpers.js')
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
  const deps = await resolveTestServerDeps(tempDir)
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
    await mkdir(join(tempDir, '01M8BBN7JS60N0ZAR13NP8SXBF'), { recursive: true })
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
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', new LoroDoc())
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a/child', new LoroDoc())

    await expect(deleteDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a')).rejects.toThrow(
      DocumentHasDescendantsError,
    )

    const paths = (await listDocuments('01M8BBN7JS60N0ZAR13NP8SXBF')).map((c) => c.path).sort()
    expect(paths).toEqual(['a', 'a/child'])
  })

  it('deletes a document whose name merely prefixes a sibling', async () => {
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', new LoroDoc())
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a-sibling', new LoroDoc())

    await expect(deleteDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a')).resolves.toBe(true)

    expect((await listDocuments('01M8BBN7JS60N0ZAR13NP8SXBF')).map((c) => c.path)).toEqual([
      'a-sibling',
    ])
  })

  it('moves the tree entry to the trash with its version rows kept, leaving the workspace row and a sibling canvas untouched', async () => {
    const { getDb } = await import('./db/index.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')

    const doc = new LoroDoc()
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a', doc)
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-b', doc)
    const store = new FileVersionStore()
    await store.save('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a', doc, { auto: true })

    const db = await getDb(tempDir)
    const { resolveDocumentIdAtPath } = await import('./document-store.js')
    const documentId = await resolveDocumentIdAtPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a')
    if (documentId === null) throw new Error('document missing from the tree')
    const libsqlStore = new LibsqlDocumentStore(db)

    await expect(deleteDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a')).resolves.toBe(true)

    // Kept for a restore, which rejoins them under the same documentId; the
    // trash purge is what removes them (routes/document/trash.test.ts).
    const versionsAfter = await db
      .selectFrom('versions')
      .selectAll()
      .where('documentId', '=', documentId)
      .execute()
    expect(versionsAfter).toHaveLength(1)

    // Content now lives in the workspace record: the tree node is gone and
    // the bytes were EVACUATED into the trash, not destroyed.
    const { DocumentStoreWorkspaceDocs } = await import('@kamiazya/whiteboard-workspace-index')
    const { resolveWorkspaceDocumentById, readTrashEntries } = await import(
      '@kamiazya/whiteboard-loro-adapter'
    )
    const stored = await new DocumentStoreWorkspaceDocs(libsqlStore).open(
      '01M8BBN7JS60N0ZAR13NP8SXBF',
    )
    expect(stored).not.toBeNull()
    expect(resolveWorkspaceDocumentById(stored!, documentId)).toBeNull()
    expect(readTrashEntries(stored!).map((t) => t.documentId)).toContain(documentId)

    const wsRow = await db
      .selectFrom('workspaces')
      .select(['id'])
      .where('id', '=', '01M8BBN7JS60N0ZAR13NP8SXBF')
      .executeTakeFirst()
    expect(wsRow).toBeDefined()
    // The sibling lives in the tree (documents rows retired with the
    // dual-plane collapse), so "untouched" is a listing fact.
    expect((await listDocuments('01M8BBN7JS60N0ZAR13NP8SXBF')).map((c) => c.path)).toEqual([
      'canvas-b',
    ])
  })

  // wbDocumentDelete once removed the index row and the Libsql bytes and
  // stopped there, leaving a cached doc instance behind that the HTTP route
  // evicted. Both paths now run the same teardown, and this asserts on what
  // is LEFT — the version row kept for a restore, the cache entry gone — not
  // on the tool answering { deleted: true }, which it did throughout.
  it('leaves the same state when the delete comes through wbDocumentDelete as through the HTTP path', async () => {
    const { getDb } = await import('./db/index.js')
    const { peekDoc } = await import('./doc-cache.js')
    const { resolveDocumentIdAtPath } = await import('./document-store.js')

    const doc = new LoroDoc()
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'agent-deleted', doc)
    const store = new FileVersionStore()
    const version = await store.save('01M8BBN7JS60N0ZAR13NP8SXBF', 'agent-deleted', doc, {
      auto: true,
    })
    // Populate the doc cache the way a read would, so eviction has something
    // to evict — otherwise this half of the assertion passes vacuously.
    // getDoc, not loadDocument: only the former goes through the LRU.
    const { getDoc } = await import('./document-store.js')
    await getDoc('01M8BBN7JS60N0ZAR13NP8SXBF', 'agent-deleted')
    expect(peekDoc('01M8BBN7JS60N0ZAR13NP8SXBF', 'agent-deleted')).toBeDefined()

    const db = await getDb(tempDir)
    const documentId = await resolveDocumentIdAtPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'agent-deleted')
    expect(documentId).not.toBeNull()
    if (documentId === null) throw new Error('unreachable')
    // The production wiring, so the teardown the assertion is about is the real one.
    await wbDocumentDelete(await resolveTestServerDeps(tempDir), {
      workspaceId: '01M8BBN7JS60N0ZAR13NP8SXBF',
      documentId,
    })

    const survivors = await db
      .selectFrom('versions')
      .select(['id'])
      .where('id', '=', version.id)
      .execute()
    expect(survivors).toEqual([{ id: version.id }])
    expect(peekDoc('01M8BBN7JS60N0ZAR13NP8SXBF', 'agent-deleted')).toBeUndefined()
    expect(await resolveDocumentIdAtPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'agent-deleted')).toBeNull()
  })

  it('returns false for a missing canvas without throwing; deleting the same canvas twice returns true then false', async () => {
    await expect(deleteDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'ghost')).resolves.toBe(false)

    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'once', new LoroDoc())
    await expect(deleteDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'once')).resolves.toBe(true)
    await expect(deleteDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'once')).resolves.toBe(false)
  })

  it('deletes a canvas that never had an FS blob (nothing writes one post-collapse)', async () => {
    // saveDocument never writes an FS blob — content lives entirely in the
    // workspace record's Libsql-backed bytes.
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'row-only', new LoroDoc())

    await expect(deleteDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'row-only')).resolves.toBe(true)
    expect(
      await (await import('./document-store.js')).resolveDocumentIdAtPath(
        '01M8BBN7JS60N0ZAR13NP8SXBF',
        'row-only',
      ),
    ).toBeNull()
  })
})

describe('renameDocumentPath', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-rename-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, '01M8BBN7JS60N0ZAR13NP8SXBF'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('moves only the path: version rows and the Libsql snapshot stay byte-identical and keyed to the same documentId', async () => {
    const { getDb } = await import('./db/index.js')

    const doc = new LoroDoc()
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', doc)
    const store = new FileVersionStore()
    const version = await store.save('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', doc, { auto: true })

    const db = await getDb(tempDir)
    const beforeId = await (await import('./document-store.js')).resolveDocumentIdAtPath(
      '01M8BBN7JS60N0ZAR13NP8SXBF',
      'a',
    )
    if (beforeId === null) throw new Error('document missing from the tree')
    const before = { id: beforeId }
    const documentId = before.id
    const contentBefore = (await loadDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a')).toJSON()

    await expect(renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', 'b')).resolves.toEqual({
      documentId,
    })

    const list = await listDocuments('01M8BBN7JS60N0ZAR13NP8SXBF')
    expect(list.map((c) => c.path)).toEqual(['b'])

    const afterId = await (await import('./document-store.js')).resolveDocumentIdAtPath(
      '01M8BBN7JS60N0ZAR13NP8SXBF',
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
    expect((await loadDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'b')).toJSON()).toEqual(contentBefore)
  })

  it('returns null (never throws) for a missing source canvas', async () => {
    await expect(
      renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'ghost', 'somewhere'),
    ).resolves.toBeNull()
  })

  it('throws ConflictError for an already-taken target path and mutates neither canvas', async () => {
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', new LoroDoc())
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'b', new LoroDoc())

    await expect(renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', 'b')).rejects.toThrow(
      ConflictError,
    )

    const list = await listDocuments('01M8BBN7JS60N0ZAR13NP8SXBF')
    expect(list.map((c) => c.path).sort()).toEqual(['a', 'b'])
  })

  it('throws the path validator error for an invalid target path', async () => {
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', new LoroDoc())
    await expect(renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', '../evil')).rejects.toThrow()
  })

  it('rename to the SAME path is a no-op success, returning the existing documentId', async () => {
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', new LoroDoc())
    const { getDb } = await import('./db/index.js')
    const _db = await getDb(tempDir)
    const beforeId = await (await import('./document-store.js')).resolveDocumentIdAtPath(
      '01M8BBN7JS60N0ZAR13NP8SXBF',
      'a',
    )
    if (beforeId === null) throw new Error('document missing from the tree')
    const before = { id: beforeId }

    await expect(renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', 'a')).resolves.toEqual({
      documentId: before.id,
    })

    const list = await listDocuments('01M8BBN7JS60N0ZAR13NP8SXBF')
    expect(list.map((c) => c.path)).toEqual(['a'])
  })

  // A path IS the hierarchy, so renaming one carries everything under it.
  // Moving only the named row leaves its children addressed below a prefix
  // no document owns — reachable by nothing the UI can show, and produced by
  // the ordinary act of renaming a group.
  it('carries every descendant with the renamed path', async () => {
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'design', new LoroDoc())
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'design/login', new LoroDoc())
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'design/deep/notes', new LoroDoc())
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'designs-elsewhere', new LoroDoc())

    await renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'design', 'product')

    const paths = (await listDocuments('01M8BBN7JS60N0ZAR13NP8SXBF')).map((c) => c.path).sort()
    expect(paths).toEqual(['designs-elsewhere', 'product', 'product/deep/notes', 'product/login'])
  })

  // The prefix test above would pass with a blind string replace; this one
  // fails unless the rewrite is anchored at a segment boundary.
  it('does not carry a sibling that merely shares the name as a prefix', async () => {
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'design', new LoroDoc())
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'design-system', new LoroDoc())

    await renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'design', 'product')

    const paths = (await listDocuments('01M8BBN7JS60N0ZAR13NP8SXBF')).map((c) => c.path).sort()
    expect(paths).toEqual(['design-system', 'product'])
  })

  // The one rule `planSubtreeMove` deliberately does NOT enforce, so each
  // caller has to. Without it the depth-ordered write — correct for the
  // upward move it was written for — is inverted, and the shallow row lands
  // on a path its own descendant has not vacated yet.
  it('refuses to move a document inside itself rather than raising a raw constraint error', async () => {
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', new LoroDoc())
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a/x', new LoroDoc())

    await expect(renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', 'a/x')).rejects.toThrow(
      DocumentMoveIntoSelfError,
    )

    const paths = (await listDocuments('01M8BBN7JS60N0ZAR13NP8SXBF')).map((c) => c.path).sort()
    expect(paths).toEqual(['a', 'a/x'])
  })

  it('refuses to nest a document inside itself even when the destination is free', async () => {
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', new LoroDoc())
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a/b', new LoroDoc())

    await expect(renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', 'a/nested')).rejects.toThrow(
      DocumentMoveIntoSelfError,
    )

    const paths = (await listDocuments('01M8BBN7JS60N0ZAR13NP8SXBF')).map((c) => c.path).sort()
    expect(paths).toEqual(['a', 'a/b'])
  })

  it('rejects a rename that would collide with an existing descendant path', async () => {
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', new LoroDoc())
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a/x', new LoroDoc())
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'c/x', new LoroDoc())

    // `a` -> `c` is free at the top, and still collides: `a/x` would land on
    // the occupied `c/x`.
    await expect(renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', 'c')).rejects.toThrow(
      ConflictError,
    )

    const paths = (await listDocuments('01M8BBN7JS60N0ZAR13NP8SXBF')).map((c) => c.path).sort()
    expect(paths).toEqual(['a', 'a/x', 'c/x'])
  })

  it('evicts every moved path from the cache, not only the two named ones', async () => {
    const { peekDoc, clearDocCacheForTests } = await import('./doc-cache.js')
    const { getDoc } = await import('./document-store.js')
    clearDocCacheForTests()
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', new LoroDoc())
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a/child', new LoroDoc())
    await getDoc('01M8BBN7JS60N0ZAR13NP8SXBF', 'a/child')
    expect(peekDoc('01M8BBN7JS60N0ZAR13NP8SXBF', 'a/child')).not.toBeUndefined()

    await renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', 'b')

    // A stale instance cached under the old child path would be resurrected
    // by the next read through it, shadowing the moved document.
    expect(peekDoc('01M8BBN7JS60N0ZAR13NP8SXBF', 'a/child')).toBeUndefined()
  })

  it('evicts the old cache key so a subsequent getDoc under the old path misses the cache', async () => {
    const { peekDoc, clearDocCacheForTests } = await import('./doc-cache.js')
    const { getDoc } = await import('./document-store.js')
    clearDocCacheForTests()
    try {
      await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', new LoroDoc())
      await getDoc('01M8BBN7JS60N0ZAR13NP8SXBF', 'a')
      expect(peekDoc('01M8BBN7JS60N0ZAR13NP8SXBF', 'a')).toBeDefined()

      await renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', 'b')
      expect(peekDoc('01M8BBN7JS60N0ZAR13NP8SXBF', 'a')).toBeUndefined()
    } finally {
      clearDocCacheForTests()
    }
  })

  it('serves the renamed content at a destination path that was read while empty', async () => {
    const { peekDoc, clearDocCacheForTests } = await import('./doc-cache.js')
    const { getDoc } = await import('./document-store.js')
    clearDocCacheForTests()
    try {
      // Write real content under 'a'.
      const doc = new LoroDoc()
      doc.getText('content').insert(0, 'real content')
      doc.commit()
      await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', doc)

      // A read of the not-yet-placed path 'b' is answered empty, and must
      // leave nothing behind to shadow the document renamed onto it.
      await getDoc('01M8BBN7JS60N0ZAR13NP8SXBF', 'b')
      expect(peekDoc('01M8BBN7JS60N0ZAR13NP8SXBF', 'b')).toBeUndefined()

      await renameDocumentPath('01M8BBN7JS60N0ZAR13NP8SXBF', 'a', 'b')

      const reloaded = await getDoc('01M8BBN7JS60N0ZAR13NP8SXBF', 'b')
      expect(reloaded.getText('content').toString()).toBe('real content')
    } finally {
      clearDocCacheForTests()
    }
  })
})
