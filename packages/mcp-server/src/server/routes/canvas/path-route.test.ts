import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { onCanvasAction, onCanvasFile } from './path-route.js'

describe('onCanvasAction', () => {
  function appWith(action: string) {
    const app = new Hono()
    onCanvasAction(app, 'get', action, (c, workspaceId, path) => c.json({ workspaceId, path }))
    return app
  }

  it('parses a nested document path with the action suffix anchoring it', async () => {
    const res = await appWith('snapshot').request('/api/w/ws1/canvas/notes/2026/plan/snapshot')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspaceId: 'ws1', path: 'notes/2026/plan' })
  })

  it('keeps a path whose last segment collides with the action unambiguous', async () => {
    const res = await appWith('snapshot').request('/api/w/ws1/canvas/a/snapshot/snapshot')
    expect(await res.json()).toEqual({ workspaceId: 'ws1', path: 'a/snapshot' })
  })

  it('falls through on a non-matching action so siblings get their turn', async () => {
    const app = new Hono()
    onCanvasAction(app, 'get', 'exists', (c) => c.json({ hit: 'exists' }))
    onCanvasAction(app, 'get', 'snapshot', (c) => c.json({ hit: 'snapshot' }))
    const res = await app.request('/api/w/ws1/canvas/doc/snapshot')
    expect(await res.json()).toEqual({ hit: 'snapshot' })
  })

  it('rejects an invalid path segment with 400, not a match failure', async () => {
    const res = await appWith('exists').request('/api/w/ws1/canvas/has%20space/exists')
    expect(res.status).toBe(400)
  })

  it('does not swallow a bare action with no document path', async () => {
    const res = await appWith('exists').request('/api/w/ws1/canvas/exists')
    expect(res.status).toBe(404)
  })
})

describe('onCanvasFile', () => {
  it('splits the file tail off a nested document path', async () => {
    const app = new Hono()
    onCanvasFile(app, 'get', (c, workspaceId, path, fileId) =>
      c.json({ workspaceId, path, fileId }),
    )
    const res = await app.request('/api/w/ws1/canvas/a/file/b/file/c')
    expect(res.status).toBe(200)
    // Greedy: the LAST /file/<id> is the file tail, the rest is the path.
    expect(await res.json()).toEqual({ workspaceId: 'ws1', path: 'a/file/b', fileId: 'c' })
  })
})
