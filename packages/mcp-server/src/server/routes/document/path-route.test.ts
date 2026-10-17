import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { matchDocumentsTail, onDocumentAction, onDocumentFile } from './path-route.js'

describe('onDocumentAction', () => {
  function appWith(action: Parameters<typeof onDocumentAction>[2]) {
    const app = new Hono()
    onDocumentAction(app, 'get', action, (c, workspaceId, path) => c.json({ workspaceId, path }))
    return app
  }

  it('parses a nested document path with the action suffix anchoring it', async () => {
    const res = await appWith('snapshot').request('/api/w/ws1/document/notes/2026/plan/snapshot')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspaceId: 'ws1', path: 'notes/2026/plan' })
  })

  it('keeps a path whose last segment collides with the action unambiguous', async () => {
    const res = await appWith('snapshot').request('/api/w/ws1/document/a/snapshot/snapshot')
    expect(await res.json()).toEqual({ workspaceId: 'ws1', path: 'a/snapshot' })
  })

  it('falls through on a non-matching action so siblings get their turn', async () => {
    const app = new Hono()
    onDocumentAction(app, 'get', 'client-count', (c) => c.json({ hit: 'client-count' }))
    onDocumentAction(app, 'get', 'snapshot', (c) => c.json({ hit: 'snapshot' }))
    const res = await app.request('/api/w/ws1/document/doc/snapshot')
    expect(await res.json()).toEqual({ hit: 'snapshot' })
  })

  it('rejects an invalid path segment with 400, not a match failure', async () => {
    const res = await appWith('client-count').request(
      '/api/w/ws1/document/has%20space/client-count',
    )
    expect(res.status).toBe(400)
  })

  it('does not swallow a bare action with no document path', async () => {
    const res = await appWith('client-count').request('/api/w/ws1/document/client-count')
    expect(res.status).toBe(404)
  })

  // Every action shares one wildcard, so a middleware the route lists has to
  // be scoped to its own action: an update's body ceiling and content slot
  // must not run for a sibling action's request.
  it("runs a route's middleware only for its own action", async () => {
    const app = new Hono()
    const ran: string[] = []
    onDocumentAction(
      app,
      'post',
      'update',
      (c) => c.json({ hit: 'update' }),
      async (_c, next) => {
        ran.push('update middleware')
        await next()
      },
    )
    onDocumentAction(app, 'post', 'export', (c) => c.json({ hit: 'export' }))

    const exported = await app.request('/api/w/ws1/document/doc/export', { method: 'POST' })
    expect(await exported.json()).toEqual({ hit: 'export' })
    expect(ran).toEqual([])

    const updated = await app.request('/api/w/ws1/document/doc/update', { method: 'POST' })
    expect(await updated.json()).toEqual({ hit: 'update' })
    expect(ran).toEqual(['update middleware'])
  })
})

describe('onDocumentFile', () => {
  it('splits the file tail off a nested document path', async () => {
    const app = new Hono()
    onDocumentFile(app, 'get', (c, workspaceId, path, fileId) =>
      c.json({ workspaceId, path, fileId }),
    )
    const res = await app.request('/api/w/ws1/document/a/file/b/file/c')
    expect(res.status).toBe(200)
    // Greedy: the LAST /file/<id> is the file tail, the rest is the path.
    expect(await res.json()).toEqual({ workspaceId: 'ws1', path: 'a/file/b', fileId: 'c' })
  })

  it("runs a route's middleware only for a file tail", async () => {
    const app = new Hono()
    const ran: string[] = []
    onDocumentFile(
      app,
      'put',
      (c) => c.json({ hit: 'file' }),
      async (_c, next) => {
        ran.push('file middleware')
        await next()
      },
    )
    onDocumentAction(app, 'put', 'update', (c) => c.json({ hit: 'update' }))

    const updated = await app.request('/api/w/ws1/document/doc/update', { method: 'PUT' })
    expect(await updated.json()).toEqual({ hit: 'update' })
    expect(ran).toEqual([])
  })
})

describe('matchDocumentsTail', () => {
  it('anchors the suffix at the END, so a document named after it stays reachable', () => {
    expect(
      matchDocumentsTail('/api/workspaces/ws1/documents/a/versions/versions', ['versions']),
    ).toEqual({ workspaceId: 'ws1', path: 'a/versions', params: {} })
  })

  it('captures a `:name` suffix segment as a param', () => {
    expect(
      matchDocumentsTail('/api/workspaces/ws1/documents/notes/plan/versions/v7/document', [
        'versions',
        ':id',
        'document',
      ]),
    ).toEqual({ workspaceId: 'ws1', path: 'notes/plan', params: { id: 'v7' } })
  })

  it('takes the whole tail as the path for an empty pattern', () => {
    expect(matchDocumentsTail('/api/workspaces/ws1/documents/a/b/c', [])).toEqual({
      workspaceId: 'ws1',
      path: 'a/b/c',
      params: {},
    })
  })

  it('decodes each segment, so an encoded slash is part of ONE segment', () => {
    expect(
      matchDocumentsTail('/api/workspaces/my%20ws/documents/a%2Fb/versions', ['versions']),
    ).toEqual({ workspaceId: 'my ws', path: 'a/b', params: {} })
  })

  it.each([
    ['a different prefix', '/api/w/ws1/document/a/versions', ['versions']],
    ['a suffix that does not match', '/api/workspaces/ws1/documents/a/pins', ['versions']],
    [
      'no path left once the suffix is taken',
      '/api/workspaces/ws1/documents/versions',
      ['versions'],
    ],
    ['an empty segment', '/api/workspaces/ws1/documents/a//versions', ['versions']],
    [
      'undecodable percent-escapes',
      '/api/workspaces/ws1/documents/a/%E0%A4%A/versions',
      ['versions'],
    ],
  ])('answers null for %s, so the registration falls through', (_why, path, pattern) => {
    expect(matchDocumentsTail(path, pattern as string[])).toBeNull()
  })

  it('ignores one trailing slash', () => {
    expect(matchDocumentsTail('/api/workspaces/ws1/documents/a/versions/', ['versions'])).toEqual({
      workspaceId: 'ws1',
      path: 'a',
      params: {},
    })
  })
})
