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

describe('two concurrent creates into the same new handle converge', () => {
  it('agrees on one workspace instead of one of them losing the segment race', async () => {
    await prepareDataDir(tmp.dir)
    const db = await getDb(tmp.dir)
    const deps = resolveServerDeps(
      createContainer(createStoreLocalModule({ db, blobDir: tmp.dir })),
    )

    // The mint reads `resolveWorkspace` and then writes, and the write lock
    // is keyed by the id it just GENERATED — so two callers bootstrapping
    // the same new handle take different locks and never serialise. Both see
    // no workspace, both mint, and the second reaches the `segment` unique
    // index (migration 0018) and raises `WorkspaceSegmentTakenError`. That
    // turns an idempotent bootstrap — a flag callers are told they may set on
    // every request — into a failure that depends on timing.
    const before = (await deps.documentIndex.listWorkspaces()).length
    const [a, b] = await Promise.all([
      wbDocumentCreate(deps, {
        workspaceId: 'contested',
        path: 'a',
        kind: 'markdown',
        createWorkspace: true,
      }),
      wbDocumentCreate(deps, {
        workspaceId: 'contested',
        path: 'b',
        kind: 'markdown',
        createWorkspace: true,
      }),
    ])

    expect(a.workspaceId).toBe(b.workspaceId)
    const listed = await deps.documentIndex.listWorkspaces()
    expect(listed.filter((w) => w.segment === 'contested')).toHaveLength(1)
    // Both documents landed in the agreed workspace — a loser that silently
    // wrote into its own minted id would satisfy the count above.
    const docs = await deps.documentIndex.listDocuments({ workspaceId: a.workspaceId })
    expect(docs.map((d) => d.path).sort()).toEqual(['a', 'b'])
    // Exactly one workspace appeared. The loser generated an id before it
    // wrote, so a keeper that claimed the tree record ahead of the segment
    // would strand a segment-less workspace under that id — which the
    // segment filter above cannot see.
    expect(listed.length - before).toBe(1)
  })
})
