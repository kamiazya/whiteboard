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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeDocumentIndexConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, vi } from 'vitest'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { CacheCoherentDocumentIndex, cacheBackedWorkspaceDocs, workspaceRegistry } = await import(
  './document-store.js'
)
const { FsBlobStore } = await import('./fs/fs-blob-store.js')
const { clearCache } = await import('./doc-cache.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

describe('CacheCoherentDocumentIndex (the daemon production index)', () => {
  describeDocumentIndexConformance(async () => {
    // Self-contained per call: the suite invokes this factory once per test,
    // so setup/teardown live here rather than in beforeEach hooks it cannot
    // see. The module-level doc cache is cleared for the same reason —
    // production has one process-wide cache, and a stale entry from the
    // previous case is exactly the class this wrapper exists to manage.
    tempDir = await mkdtemp(join(tmpdir(), 'prod-index-conformance-'))
    const handle = await createIsolatedDb({ dataDir: tempDir })
    clearCache()
    const index = new CacheCoherentDocumentIndex(
      cacheBackedWorkspaceDocs(),
      new FsBlobStore(tempDir),
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
      seedWorkspace: async (entry) => {
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
  })
})
