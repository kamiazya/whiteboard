import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AuthScope } from './auth-strategy.js'
import { holdV1CreateBodyToScope } from './v1-create-body-scope.js'

const CREATE = '/api/v1/workspaces/ws1/documents'

function appGranting(scopes: readonly AuthScope[] | undefined) {
  const app = new Hono()
  app.use(
    '/api/v1/*',
    holdV1CreateBodyToScope(() => scopes),
  )
  // The route behind it reads the same body again, as server-core's does.
  app.post('/api/v1/*', async (c) => c.json({ read: await c.req.text() }, 201))
  return app
}

const post = (app: Hono, body: string, path = CREATE) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })

const BODY = JSON.stringify({ path: 'plan', kind: 'markdown', markdown: '# Plan' })

describe('holdV1CreateBodyToScope', () => {
  it('refuses a create carrying markdown to a grant without canvas:write', async () => {
    const res = await post(appGranting(['workspace:write']), BODY)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'insufficient_scope' })
  })

  it('passes it, body intact, once the grant holds canvas:write', async () => {
    const res = await post(appGranting(['workspace:write', 'canvas:write']), BODY)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ read: BODY })
  })

  it('passes a create with no body to workspace:write alone', async () => {
    const res = await post(
      appGranting(['workspace:write']),
      JSON.stringify({ path: 'p', kind: 'spatial' }),
    )
    expect(res.status).toBe(201)
  })

  it('leaves a body that is not JSON for the route to refuse', async () => {
    expect((await post(appGranting(['workspace:write']), '{not json')).status).toBe(201)
  })

  it('refuses a create that reached it with no recorded grant', async () => {
    // Either mode's auth middleware records a grant before /api/v1, so none
    // recorded means the request got here some other way: fail closed, even
    // for a body that asks for no more than placing a document.
    const spatial = JSON.stringify({ path: 'p', kind: 'spatial' })
    for (const body of [BODY, spatial, '{not json']) {
      const res = await post(appGranting(undefined), body)
      expect(res.status, body).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'insufficient_scope' })
    }
  })

  it('judges only the create route', async () => {
    const res = await post(appGranting(['workspace:write']), BODY, '/api/v1/workspaces/ws1/other')
    expect(res.status).toBe(201)
  })
})
