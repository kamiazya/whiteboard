import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { createCredentialResolver } from './credential-resolver.js'
import { createLocalTokenMcpHttpAuthStrategy } from './mcp-auth.js'
import { createMcpHttpAuthMiddleware } from './mcp-http.js'

/**
 * The middleware's job is carrying the REQUEST into the strategy. The
 * strategy's own tests build the context by hand, so they cannot see a field
 * this layer forgets to pass.
 */
describe('createMcpHttpAuthMiddleware carries the request into the strategy', () => {
  const app = () => {
    const hono = new Hono()
    hono.use(
      '/mcp',
      createMcpHttpAuthMiddleware(
        createLocalTokenMcpHttpAuthStrategy({
          resolver: createCredentialResolver({ daemonToken: 'secret' }),
        }),
      ),
    )
    hono.post('/mcp', (c) => c.json({ reached: true }))
    return hono
  }

  it('passes the Authorization header through, so the daemon token is admitted', async () => {
    const res = await app().request('/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
  })

  it('answers 401 with no credential', async () => {
    const res = await app().request('/mcp', { method: 'POST' })
    expect(res.status).toBe(401)
  })
})
