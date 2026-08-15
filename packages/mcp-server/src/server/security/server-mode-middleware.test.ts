import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AsyncAuthStrategy } from './oauth-resource-strategy.js'
import { createServerModeApiAuthMiddleware } from './server-mode-middleware.js'

// route-scope-registry.ts returns null for any /api/* path no rule claims,
// and the middleware's contract for that case is fail-closed: refuse with
// auth.route-undeclared rather than fall through to the auth strategy. An
// allow-all strategy is the mutation-sensitive witness here — if the branch
// regressed to `next()`, this strategy would happily authorize the request
// and the handler's 200 would leak through.
const allowAllStrategy: AsyncAuthStrategy = {
  authorize: async () => ({ ok: true, context: { kind: 'local-token' } }),
}

function buildApp() {
  const app = new Hono()
  app.use('/api/*', createServerModeApiAuthMiddleware(allowAllStrategy))
  app.get('/api/undeclared-route-for-test', (c) => c.json({ reached: true }))
  return app
}

describe('createServerModeApiAuthMiddleware', () => {
  it('fails closed with auth.route-undeclared for a route absent from the registry', async () => {
    const app = buildApp()
    const res = await app.request('/api/undeclared-route-for-test')
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'auth.route-undeclared' })
  })
})
