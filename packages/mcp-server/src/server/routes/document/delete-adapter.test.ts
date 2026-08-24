/**
 * ADR-0018: the HTTP DELETE is an ADAPTER over `wb_document_delete`, not a
 * second implementation of it.
 *
 * The two used to be separate code paths performing the same delete, and
 * only one of them cleaned up (#1035). Sharing the pieces closed that gap
 * one piece at a time; sharing the OPERATION is what stops the next piece
 * from drifting, because there is no longer a second sequence to forget to
 * update.
 *
 * Asserted through the seam the operation goes through rather than on the
 * rows afterwards: identical end state is exactly what the two divergent
 * implementations produced right up until one of them grew a step.
 */
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-delete-adapter-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveDocument } = await import('../../store/document-store.js')
const { getDb } = await import('../../store/db/index.js')
const { createContainer, resolveServerDeps } = await import('../../../di/container.js')
const { createStoreLocalModule } = await import('../../../di/store-local.module.js')
const { createWorkspacesRouter } = await import('./workspaces.js')

async function depsRecordingTeardown(): Promise<{
  deps: Awaited<ReturnType<typeof resolveServerDeps>>
  entered: string[]
}> {
  const db = await getDb(tmp.dir)
  const deps = resolveServerDeps(createContainer(createStoreLocalModule({ db, blobDir: tmp.dir })))
  const entered: string[] = []
  const real = deps.documentTeardown
  deps.documentTeardown = {
    around(input, deleteDocument) {
      entered.push(`${input.workspaceId}:${input.path}`)
      return real.around(input, deleteDocument)
    },
  }
  return { deps, entered }
}

describe('DELETE /api/workspaces/:workspaceId/documents/:path', () => {
  beforeEach(async () => {
    await saveDocument('ws-1', 'doomed', new LoroDoc())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deletes through the injected operation rather than its own sequence', async () => {
    const { deps, entered } = await depsRecordingTeardown()
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents/doomed', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(entered).toEqual(['ws-1:doomed'])
  })

  it('still answers 404 for a path that names nothing', async () => {
    const { deps, entered } = await depsRecordingTeardown()
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents/never-existed', {
      method: 'DELETE',
    })

    expect(res.status).toBe(404)
    // A delete that found nothing must not enter teardown: the cleanup would
    // be reaching for files belonging to a document it never identified.
    expect(entered).toEqual([])
  })
})
