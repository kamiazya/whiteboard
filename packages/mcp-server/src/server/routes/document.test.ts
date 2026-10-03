import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  resolveTestServerDeps,
  testDocumentRouterOptions,
  testStoreScope,
  withTempDataDir,
} from './_test-helpers.js'

const tmp = withTempDataDir('whiteboard-routes-test-')

// The deps a router is handed by its root; here, the test wiring over the
// temp data dir (routers no longer compose their own).
let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
})

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearDocCacheForTests } = await import('../store/doc-cache.js')

// Dynamically import the Hono app.
const { createDocumentRouter } = await import('./document.js')

// document.ts's own job is composing the document/*.ts sub-routers into one
// router (see route-coverage.test.ts, which requires every route source
// file to keep a sibling .test.ts). Per-behavior coverage for each
// sub-router lives beside it under document/*.test.ts; this file keeps only
// the two cross-family integration scenarios that exercise the composition
// itself — a nested document path routed correctly across every sub-router
// in one request sequence.
describe('createDocumentRouter composition', () => {
  beforeEach(() => {
    clearDocCacheForTests()
  })
  afterEach(() => {
    clearDocCacheForTests()
  })

  // The router composes nothing of its own: the version store is the root's,
  // so leaving it out is a compile error rather than a second composition path
  // that only tests take. `typecheck:tests` is what holds this.
  it('requires the version store the root builds', () => {
    // @ts-expect-error versionStore is required
    const options: Parameters<typeof createDocumentRouter>[0] = {
      scope: testStoreScope(),
      serverDeps,
    }
    expect(options).not.toHaveProperty('versionStore')
  })

  it('serves a nested document path at /api/w/:workspaceId/document/*', async () => {
    // The path-addressed shape: the document path is the URL tail, one
    // segment per path segment, with the action suffix anchoring the parse.
    // A nested path is exactly what the old :path param could never match.
    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    await createTestDocument(serverDeps, {
      workspaceId: 'ws1',
      path: 'notes/2026/plan',
      kind: 'spatial',
    })

    const snapshot = await app.request('/api/w/ws1/document/notes/2026/plan/snapshot')
    expect(snapshot.status).toBe(200)

    // A document whose LAST segment is an action name stays unambiguous,
    // because the action suffix is mandatory: /a/snapshot/snapshot is the
    // document a/snapshot.
    await createTestDocument(serverDeps, {
      workspaceId: 'ws1',
      path: 'a/snapshot',
      kind: 'spatial',
    })
    const collideSnapshot = await app.request('/api/w/ws1/document/a/snapshot/snapshot')
    expect(collideSnapshot.status).toBe(200)
  })

  it('drives the whole documents family against a nested document path', async () => {
    // The second legacy family (already workspace-first, but :path could not
    // match a nested path): versions, restore, compact, name, pin, rename,
    // delete. One scenario, so a regression in ANY of them on a nested path
    // is loud.
    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    await createTestDocument(serverDeps, {
      workspaceId: 'ws1',
      path: 'notes/2026/plan',
      kind: 'spatial',
    })
    const P = '/api/workspaces/ws1/documents/notes/2026/plan'

    // name + pin (PUT with suffix)
    expect(
      (
        await app.request(`${P}/name`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Plan 2026' }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(`${P}/pin`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: true }),
        })
      ).status,
    ).toBe(200)

    // versions: create → list → restore
    const created = await app.request(`${P}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(created.status).toBe(200)
    const { version } = (await created.json()) as { version: { id: string } }
    const versionId = version.id

    const list = await app.request(`${P}/versions`)
    expect(list.status).toBe(200)

    const restore = await app.request(`${P}/versions/${versionId}/restore`, { method: 'POST' })
    expect(restore.status).toBe(200)

    // rename moves the whole subtree address
    const renamed = await app.request(`${P}/path`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes/2027/plan' }),
    })
    expect(renamed.status).toBe(200)

    // delete at the NEW nested path
    const del = await app.request('/api/workspaces/ws1/documents/notes/2027/plan', {
      method: 'DELETE',
    })
    expect(del.status).toBe(200)
  })
})
