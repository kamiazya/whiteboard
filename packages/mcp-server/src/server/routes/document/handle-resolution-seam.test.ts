/**
 * A handle is resolved against the same registry the request then reads.
 *
 * This looks like two registries and is one. `workspaceIdFromHandle` reaches
 * module-level `workspaceRegistry()`, while every route beside it takes
 * `options.serverDeps` — so a router given deps of its own reads like it could
 * resolve a segment against one store and mutate another.
 *
 * It cannot while both read one directory, and that is a property of the
 * wiring: `store-local.module.ts` builds the index over its module's
 * `StoreScope`, and `workspaceRegistry()` with no argument follows the
 * process's data dir. They agree because every root passes `getDataDir()` to
 * `bootSelfHostDeps`.
 *
 * So this pins the invariant rather than the mechanism: whatever registry
 * resolution reads, it is the one the route's own index answers from. A module
 * built over a DIFFERENT directory breaks it, and the fix then is for
 * `workspaceIdFromHandle` to take the deps' registry — which is why the
 * fixture below shares one directory instead of pretending to two.
 *
 * Addressed BY SEGMENT deliberately: a canonical id passes through
 * `resolveWorkspaceHandle` unchanged whichever registry answers, so a test
 * using one would be green against either and assert nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SELF_HOST_TENANT_ID } from '../../tenant/id.js'
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
    // Over the same directory the process registry reads, on purpose. The
    // index follows its module's directory, and the route resolves a handle
    // through `workspaceRegistry()` of the process (`workspace-handle.ts`)
    // rather than through the injected index — so a module built over another
    // directory would answer 404 here for that reason, which is not what this
    // test is about.
    const deps = resolveServerDeps(
      createContainer(
        createStoreLocalModule({
          db: await getDb(tmp.dir),
          dataDir: tmp.dir,
          tenantId: SELF_HOST_TENANT_ID,
        }),
      ),
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
