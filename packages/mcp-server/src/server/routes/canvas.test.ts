import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './_test-helpers.js'

const tmp = withTempDataDir('whiteboard-routes-test-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearCache } = await import('../store/doc-cache.js')

// Dynamically import the Hono app.
const { createCanvasRouter } = await import('./canvas.js')

// canvas.ts's own job is composing the canvas/*.ts sub-routers into one
// router (see route-coverage.test.ts, which requires every route source
// file to keep a sibling .test.ts). Per-behavior coverage for each
// sub-router lives beside it under canvas/*.test.ts; this file keeps only
// the two cross-family integration scenarios that exercise the composition
// itself — a nested document path routed correctly across every sub-router
// in one request sequence.
describe('createCanvasRouter composition', () => {
  beforeEach(() => {
    clearCache()
  })
  afterEach(() => {
    clearCache()
  })

  it('serves a nested document path at /api/w/:workspaceId/canvas/*', async () => {
    // The path-addressed shape: the document path is the URL tail, one
    // segment per path segment, with the action suffix anchoring the parse.
    // A nested path is exactly what the old :path param could never match.
    const app = createCanvasRouter()
    const createRes = await app.request('/api/workspaces/ws1/canvases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes/2026/plan', kind: 'spatial' }),
    })
    expect(createRes.status).toBe(200)

    const exists = await app.request('/api/w/ws1/canvas/notes/2026/plan/exists')
    expect(exists.status).toBe(200)
    expect(await exists.json()).toEqual({ exists: true })

    const snapshot = await app.request('/api/w/ws1/canvas/notes/2026/plan/snapshot')
    expect(snapshot.status).toBe(200)

    // A document whose LAST segment is an action name stays unambiguous,
    // because the action suffix is mandatory: /a/snapshot/snapshot is the
    // document a/snapshot.
    const collide = await app.request('/api/workspaces/ws1/canvases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'a/snapshot', kind: 'spatial' }),
    })
    expect(collide.status).toBe(200)
    const collideSnapshot = await app.request('/api/w/ws1/canvas/a/snapshot/snapshot')
    expect(collideSnapshot.status).toBe(200)
  })

  it('drives the whole canvases family against a nested document path', async () => {
    // The second legacy family (already workspace-first, but :path could not
    // match a nested path): versions, thumbnails, restore, compact, name,
    // pin, rename, delete. One scenario, so a regression in ANY of them on a
    // nested path is loud.
    const app = createCanvasRouter()
    const create = await app.request('/api/workspaces/ws1/canvases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes/2026/plan', kind: 'spatial' }),
    })
    expect(create.status).toBe(200)
    const P = '/api/workspaces/ws1/canvases/notes/2026/plan'

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

    // versions: create → list → thumbnail PUT/GET → restore
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

    const putThumb = await app.request(`${P}/versions/${versionId}/thumbnail`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    })
    expect(putThumb.status).toBe(200)
    expect((await app.request(`${P}/versions/${versionId}/thumbnail`)).status).toBe(200)
    expect((await app.request(`${P}/latest-thumbnail`)).status).toBe(200)

    const restore = await app.request(`${P}/versions/${versionId}/restore`, { method: 'POST' })
    expect(restore.status).toBe(200)

    // compact (POST with suffix)
    expect((await app.request(`${P}/compact`, { method: 'POST' })).status).toBe(200)

    // rename moves the whole subtree address
    const renamed = await app.request(`${P}/path`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes/2027/plan' }),
    })
    expect(renamed.status).toBe(200)

    // delete at the NEW nested path
    const del = await app.request('/api/workspaces/ws1/canvases/notes/2027/plan', {
      method: 'DELETE',
    })
    expect(del.status).toBe(200)
  })
})
