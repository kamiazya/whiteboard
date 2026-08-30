/**
 * A handle is resolved against the same registry the request then reads.
 *
 * This looks like two registries and is one. `workspaceIdFromHandle` reaches
 * module-level `workspaceRegistry()`, while every route beside it takes
 * `options.serverDeps` — so a router given deps of its own reads like it could
 * resolve a segment against one store and mutate another.
 *
 * It cannot, and the reason is in `store-local.module.ts`: `DocumentIndex` is
 * bound to `cacheBackedWorkspaceDocs()` and `workspaceRegistry()`, both
 * module-level. `opts.db` reaches `DocumentStore` and NOT the index. That is
 * deliberate — cache coherence is the point, every path operating on one live
 * workspace doc — but it makes "the same registry" a property of the wiring
 * rather than of anything the seam states, and wiring changes.
 *
 * So this pins the invariant rather than the mechanism: whatever registry
 * resolution reads, it is the one the route's own index answers from. Give
 * `DocumentIndex` a store of its own and this fails, which is the moment the
 * seam becomes real and every call site would need the deps threaded through.
 *
 * Addressed BY SEGMENT deliberately: a canonical id passes through
 * `resolveWorkspaceHandle` unchanged whichever registry answers, so a test
 * using one would be green against either and assert nothing.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-handle-seam-')

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
const { createWorkspacesRouter } = await import('./workspaces.js')

const WS = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'design-team'

describe('handle resolution and the request that follows it', () => {
  beforeEach(async () => {
    await prepareDataDir(tmp.dir)
  })

  it('reaches the route with the id the injected index knows the segment by', async () => {
    // Built from a SECOND data dir, so the deps are as independent as the DI
    // module lets them be. Today that changes only the blob store; if the
    // index ever follows `db` too, this fixture is what makes the divergence
    // show up here rather than in production.
    const otherDir = await mkdtemp(join(tmpdir(), 'whiteboard-handle-seam-other-'))
    await prepareDataDir(otherDir)
    const deps = resolveServerDeps(
      createContainer(createStoreLocalModule({ db: await getDb(otherDir), blobDir: otherDir })),
    )

    await deps.documentIndex.createWorkspace({ workspaceId: WS, segment: SEGMENT })

    const asked: string[] = []
    const realList = deps.documentIndex.listDocuments.bind(deps.documentIndex)
    deps.documentIndex.listDocuments = async (input: never) => {
      // What the route ASKED for, recorded before the index answers: the
      // answer alone cannot tell "resolved wrongly" from "resolved right and
      // the workspace is empty" — both are `{documents: []}`.
      asked.push((input as unknown as { workspaceId: string }).workspaceId)
      return realList(input)
    }

    const app = createWorkspacesRouter({ serverDeps: deps })
    const res = await app.request(`/api/workspaces/${SEGMENT}/documents`)

    expect(res.status).toBe(200)
    // The subject is PRESENT: a run where the route refused before reaching
    // the index would leave this empty and satisfy nothing.
    expect(asked).toHaveLength(1)
    // Resolved, not passed through. `SEGMENT` here would mean the address was
    // handed on as if it were an id.
    expect(asked[0]).toBe(WS)
  })
})
