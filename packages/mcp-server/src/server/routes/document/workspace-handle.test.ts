/**
 * The daemon's OWN routes resolve a workspace handle the way `/api/v1` and
 * the MCP tools do — segment first, canonical id second (ADR-0019).
 *
 * Separate from server-core's suite because this is a different surface with
 * a different seam: these handlers fetch their dependencies per-request from
 * module state rather than from one injected `deps`, so no single middleware
 * covers them and the resolve is a line per address read. A case per READ
 * MECHANISM is what says the line is actually there — `c.req.param()`, the
 * `/api/workspaces/.../documents/*` hand parse, and the `/api/w/...` one are
 * three separate places to forget.
 */
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-workspace-handle-')

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
const { createDocumentMetadataRouter } = await import('./metadata.js')
const { createWorkspaceDocumentRouter } = await import('./workspace-document.js')

const CANONICAL = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SEGMENT = 'design'

async function seeded(): Promise<Awaited<ReturnType<typeof resolveServerDeps>>> {
  await prepareDataDir(tmp.dir)
  const db = await getDb(tmp.dir)
  const deps = resolveServerDeps(createContainer(createStoreLocalModule({ db, blobDir: tmp.dir })))
  await deps.documentIndex.createWorkspace({ workspaceId: CANONICAL, segment: SEGMENT })
  // Asserted, not assumed: every case below is about a SEGMENT resolving, and
  // a registry that quietly dropped it would make them pass by falling through
  // to the id branch against a handle that happens to match nothing.
  const entry = (await deps.documentIndex.listWorkspaces()).find((w) => w.workspaceId === CANONICAL)
  expect(entry?.segment).toBe(SEGMENT)
  await deps.documentIndex.createDocument({
    workspaceId: CANONICAL,
    path: 'spec',
    kind: 'markdown',
  })
  return deps
}

describe('daemon routes address a workspace by its segment', () => {
  it('answers GET /api/workspaces/<segment>/documents as it does the canonical id', async () => {
    const deps = await seeded()
    const app = createWorkspacesRouter({ serverDeps: deps })

    const bySegment = await app.request(`/api/workspaces/${SEGMENT}/documents`)
    const byId = await app.request(`/api/workspaces/${CANONICAL}/documents`)

    expect(byId.status).toBe(200)
    expect(bySegment.status).toBe(200)
    expect(await bySegment.json()).toEqual(await byId.json())
  })

  it('answers GET /api/workspaces/<segment>/names as it does the canonical id', async () => {
    await seeded()
    const app = createDocumentMetadataRouter()
    // Named through the CANONICAL id first, so the two responses differ from
    // each other unless the segment reached the same workspace. Comparing the
    // bare payloads would pass on two empty ones — which is what an
    // unresolved handle answers here, since names has no absent-workspace
    // refusal to fail on.
    const named = await app.request(`/api/workspaces/${CANONICAL}/documents/spec/name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'The spec' }),
    })
    expect(named.status).toBe(200)

    const bySegment = await app.request(`/api/workspaces/${SEGMENT}/names`)
    const byId = await app.request(`/api/workspaces/${CANONICAL}/names`)

    expect(byId.status).toBe(200)
    const canonical = await byId.json()
    expect(JSON.stringify(canonical)).toContain('The spec')
    expect(bySegment.status).toBe(200)
    expect(await bySegment.json()).toEqual(canonical)
  })

  it('resolves the handle inside the /api/workspaces/.../documents/* hand parse', async () => {
    await seeded()
    const app = createDocumentMetadataRouter()

    const res = await app.request(`/api/workspaces/${SEGMENT}/documents/spec/name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'The spec' }),
    })

    // 404 here means the segment reached the store unresolved: the canonical
    // workspace holds `spec`, a workspace literally named `design` does not.
    expect(res.status).toBe(200)
  })

  it('resolves the handle inside the /api/w/... workspace-document surface', async () => {
    await seeded()
    const app = createWorkspaceDocumentRouter({ triggerAutoVersion: async () => null })

    const res = await app.request(`/api/w/${SEGMENT}/workspace-document/snapshot`)

    expect(res.status).toBe(200)
  })

  it('leaves a handle that resolves to nothing failing exactly as before', async () => {
    const deps = await seeded()
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/no-such-workspace/documents')

    expect(res.status).toBe(404)
    // The unresolved handle passes through unchanged, so the existing message
    // still names what the caller actually typed.
    expect(await res.json()).toEqual({ title: 'Workspace "no-such-workspace" not found' })
  })
})
