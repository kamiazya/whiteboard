import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { MemberProfileStore } from './member-profile-store.js'
import type { AsyncAuthStrategy } from './oauth-resource-strategy.js'
import { createServerModeApiAuthMiddleware } from './server-mode-middleware.js'
import type { SignInSessionStore } from './sign-in-session-store.js'

// route-scope-registry.ts returns null for any /api/* path no rule claims,
// and the middleware's contract for that case is fail-closed: refuse with
// auth.route-undeclared rather than fall through to the auth strategy. An
// allow-all strategy is the mutation-sensitive witness here — if the branch
// regressed to `next()`, this strategy would happily authorize the request
// and the handler's 200 would leak through.
const allowAllStrategy: AsyncAuthStrategy = {
  authorize: async () => ({ ok: true, context: { kind: 'local-token' } }),
}

// Stores that any lookup would fail on: an undeclared route is refused before
// anyone is asked who is calling.
function neverConsulted<T extends object>(): T {
  return new Proxy(
    {},
    {
      get(_target, key) {
        throw new Error(`consulted: ${String(key)}`)
      },
    },
  ) as T
}

const people = {
  members: neverConsulted<MemberProfileStore>(),
  sessions: neverConsulted<SignInSessionStore>(),
  origin: 'https://wb.test',
}

describe('createServerModeApiAuthMiddleware', () => {
  it('fails closed with auth.route-undeclared for a route absent from the registry', async () => {
    const app = new Hono()
    app.use('/api/*', createServerModeApiAuthMiddleware(allowAllStrategy, people))
    app.get('/api/undeclared-route-for-test', (c) => c.json({ reached: true }))
    const res = await app.request('/api/undeclared-route-for-test')
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'auth.route-undeclared' })
  })

  // Server mode has no daemon token, so a daemon-token-only route is refused
  // whatever the strategy would have said — the allow-all strategy is the
  // witness that the refusal is the decision's, not the credential's.
  it('refuses /api/debug outright, the route the registry holds daemon-token-only', async () => {
    const app = new Hono()
    app.use('/api/*', createServerModeApiAuthMiddleware(allowAllStrategy, people))
    app.get('/api/debug', (c) => c.json({ reached: true }))
    const res = await app.request('/api/debug')
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: 'forbidden' })
  })
})
