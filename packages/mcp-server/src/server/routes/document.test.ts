import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  documentIdAt,
  resolveTestServerDeps,
  testDocumentRouterOptions,
  testStoreScope,
  withTempDataDir,
} from './_test-helpers.js'

const tmp = withTempDataDir('whiteboard-routes-test-')

// The deps a router is handed by its root; here, the test wiring over the
// temp data dir.
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

  it('drives the whole documents family by id for a document at a nested path', async () => {
    // snapshot, versions, restore, name, pin, rename, delete: one scenario,
    // so a regression in ANY of them for a nested-path document is loud.
    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
    await createTestDocument(serverDeps, {
      workspaceId: 'ws1',
      path: 'notes/2026/plan',
      kind: 'spatial',
    })
    // 'ws1' is a segment; the index is asked by the canonical id it minted.
    const workspace = await serverDeps.documentIndex.resolveWorkspace('ws1')
    const id = await documentIdAt(serverDeps, workspace?.workspaceId ?? 'ws1', 'notes/2026/plan')
    const P = `/api/workspaces/ws1/documents/${id}`

    expect((await app.request(`${P}/snapshot`)).status).toBe(200)

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

    // rename moves the document's address, not its id
    const renamed = await app.request(`${P}/path`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes/2027/plan' }),
    })
    expect(renamed.status).toBe(200)

    // the id still addresses the document at its new path
    const del = await app.request(P, {
      method: 'DELETE',
    })
    expect(del.status).toBe(200)
  })
})
