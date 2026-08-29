/**
 * ADR-0019's mint against the DAEMON's real index, not the in-memory double.
 *
 * The operation is shared, but the registry is not: `CacheCoherentDocumentIndex`
 * writes segments to a SQLite column and reads them back through a separate
 * collaborator, so "the segment resolves" has to be asserted here too.
 */
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-mint-daemon-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { getDb } = await import('../../store/db/index.js')
const { prepareDataDir } = await import('../../store/db/prepare.js')
const { createContainer, resolveServerDeps } = await import('../../../di/container.js')
const { createStoreLocalModule } = await import('../../../di/store-local.module.js')
const { wbDocumentCreate } = await import('@kamiazya/whiteboard-server-core')

describe('the daemon mints and then resolves its own segment', () => {
  it('files the posted handle as a segment the registry can resolve back', async () => {
    await prepareDataDir(tmp.dir)
    const db = await getDb(tmp.dir)
    const deps = resolveServerDeps(
      createContainer(createStoreLocalModule({ db, blobDir: tmp.dir })),
    )

    const created = await wbDocumentCreate(deps, {
      workspaceId: 'e2e',
      path: 'spec',
      kind: 'markdown',
      createWorkspace: true,
    })

    expect(created.workspaceId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)

    // The registry row carries the segment...
    const listed = await deps.documentIndex.listWorkspaces()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ workspaceId: created.workspaceId, segment: 'e2e' })

    // ...and resolution reads it back. This is the step the published smoke
    // caught failing: everything after a create addresses the workspace by
    // the handle, and if the daemon's own index cannot resolve it, every one
    // of those calls answers "workspace not found".
    const resolved = await deps.documentIndex.resolveWorkspace('e2e')
    expect(resolved?.workspaceId).toBe(created.workspaceId)
  })
})
