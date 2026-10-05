/**
 * The daemon's PRODUCTION index — CacheCoherentDocumentIndex over the
 * DB-backed registry and FsBlobStore, exactly as store-local.module.ts
 * binds it — run through the DocumentIndex port's conformance suite.
 *
 * Every other implementation already passed this bar (the in-memory double,
 * the browser store, the bare LoroWorkspaceDocumentIndex); the one that
 * persists and serves production traffic was the one never checked. The
 * suite lives beside the port (ports/test-utils) precisely so this file is
 * one wiring, not a second copy of 38 cases.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readMarkdownBody,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import {
  describeDocumentDuplicatesConformance,
  describeDocumentIndexConformance,
  describeDocumentPinsConformance,
  describeDocumentTrashConformance,
} from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { blobsRoot } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const {
  CacheCoherentDocumentIndex,
  cacheBackedWorkspaceDocs,
  getDoc,
  saveDocument,
  workspaceRegistry,
} = await import('./document-store.js')
const { FsBlobStore } = await import('./fs/fs-blob-store.js')
const { clearDocCacheForTests } = await import('./doc-cache.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

async function makeProductionIndex() {
  // Self-contained per call: the suite invokes this factory once per test,
  // so setup/teardown live here rather than in beforeEach hooks it cannot
  // see. The module-level doc cache is cleared for the same reason —
  // production has one process-wide cache, and a stale entry from the
  // previous case is exactly the class this wrapper exists to manage.
  tempDir = await mkdtemp(join(tmpdir(), 'prod-index-conformance-'))
  const handle = await createIsolatedDb({ dataDir: tempDir })
  clearDocCacheForTests()
  const index = new CacheCoherentDocumentIndex(
    cacheBackedWorkspaceDocs(),
    new FsBlobStore(blobsRoot(tempDir, SELF_HOST_TENANT_ID), tempDir),
    workspaceRegistry(),
  )
  return {
    index,
    dispose: async () => {
      await handle.dispose()
      await rm(tempDir, { recursive: true, force: true })
    },
    // The registry the index resolves against is the workspaces TABLE, and
    // only the composition root writes rows — so the seed writes one
    // directly, updating identity if createWorkspace already inserted the
    // id (its own insert is doNothing on conflict and MAY ignore segment,
    // which is the very reason the port makes this seam mandatory).
    seedWorkspace: async (entry: WorkspaceEntry) => {
      const now = Date.now()
      await handle.db
        .insertInto('workspaces')
        .values({
          id: entry.workspaceId,
          segment: entry.segment ?? null,
          displayName: entry.displayName ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            segment: entry.segment ?? null,
            displayName: entry.displayName ?? null,
            updatedAt: now,
          }),
        )
        .execute()
    },
  }
}

/** A document's body through the live-document seam every daemon route reads and saves by. */
const liveMarkdownContent = {
  async write(workspaceId: string, path: string, marker: string): Promise<void> {
    const doc = await getDoc(workspaceId, path)
    writeMarkdownBody(doc, marker)
    await saveDocument(workspaceId, path, doc, { kind: 'markdown', overwrite: true })
  },
  async read(workspaceId: string, path: string): Promise<string> {
    return readMarkdownBody(await getDoc(workspaceId, path))
  },
}

/** Every file under the tenant's blob root: the trash suite trashes documents only, so each is an evacuation. */
async function blobFileCount(): Promise<number> {
  try {
    const entries = await readdir(blobsRoot(tempDir, SELF_HOST_TENANT_ID), {
      recursive: true,
      withFileTypes: true,
    })
    return entries.filter((entry) => entry.isFile()).length
  } catch {
    return 0
  }
}

describe('CacheCoherentDocumentIndex (the daemon production index)', () => {
  describeDocumentIndexConformance(makeProductionIndex)
  describeDocumentPinsConformance(makeProductionIndex)
  describeDocumentTrashConformance(async () => {
    const { index, dispose } = await makeProductionIndex()
    return { index, dispose, evacuatedBlobCount: blobFileCount }
  })
  describeDocumentDuplicatesConformance(async () => {
    const { index, dispose } = await makeProductionIndex()
    return { index, dispose, content: liveMarkdownContent }
  })

  // The doc cache is keyed by path too, so an empty read of a path nothing
  // holds must leave nothing a copy landing there could be served as.
  it('serves a copy as its content even after its path was read while empty', async () => {
    const { index, dispose } = await makeProductionIndex()
    try {
      const workspaceId = 'ws-duplicate-phantom'
      await index.createWorkspace({ workspaceId })
      await index.createDocument({ workspaceId, path: 'note', kind: 'markdown' })
      await liveMarkdownContent.write(workspaceId, 'note', 'the source')
      expect(readMarkdownBody(await getDoc(workspaceId, 'note-copy'))).toBe('')

      await index.duplicateDocument({ workspaceId, path: 'note' })

      await expect(liveMarkdownContent.read(workspaceId, 'note-copy')).resolves.toBe('the source')
    } finally {
      await dispose()
    }
  })

  // A restore places a document back at a path a stale reader may have looked
  // at while it stood empty; that empty read must not be what the path serves
  // afterwards, nor what the next save through the live seam writes back.
  it('serves a restored document as its content even after its path was read while trashed', async () => {
    const { index, dispose } = await makeProductionIndex()
    try {
      const workspaceId = 'ws-restore-phantom'
      await index.createWorkspace({ workspaceId })
      const created = await index.createDocument({ workspaceId, path: 'note', kind: 'markdown' })
      await liveMarkdownContent.write(workspaceId, 'note', 'the source')
      await index.deleteDocument({ workspaceId, path: 'note' })
      expect(readMarkdownBody(await getDoc(workspaceId, 'note'))).toBe('')

      await index.restoreDocument({ workspaceId, documentId: created.documentId })

      await expect(liveMarkdownContent.read(workspaceId, 'note')).resolves.toBe('the source')
      await liveMarkdownContent.write(workspaceId, 'note', 'the source + edit')
      clearDocCacheForTests()
      await expect(liveMarkdownContent.read(workspaceId, 'note')).resolves.toBe('the source + edit')
    } finally {
      await dispose()
    }
  })

  // The doc cache is keyed by path, so the document a delete leaves behind in
  // it would be served as the next document created at that path.
  it('serves a document recreated at a deleted path as itself, not as the one deleted', async () => {
    const { index, dispose } = await makeProductionIndex()
    try {
      const workspaceId = 'ws-recreate'
      await index.createWorkspace({ workspaceId })
      const first = new LoroDoc()
      writeDocumentKind(first, 'markdown')
      writeMarkdownBody(first, 'the deleted document')
      await saveDocument(workspaceId, 'note', first, { kind: 'markdown' })
      expect(readMarkdownBody(await getDoc(workspaceId, 'note'))).toBe('the deleted document')

      await index.deleteDocument({ workspaceId, path: 'note' })
      await index.createDocument({ workspaceId, path: 'note', kind: 'markdown' })

      expect(readMarkdownBody(await getDoc(workspaceId, 'note'))).toBe('')
    } finally {
      await dispose()
    }
  })
})
