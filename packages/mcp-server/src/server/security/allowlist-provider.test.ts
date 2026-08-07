/**
 * Tri-surface allowlist-provider contract (pairing-grant groundwork).
 *
 * A pairing grant approved at runtime must be admitted by ALL THREE
 * origin-checking surfaces without a restart: the /api CORS middleware,
 * the /mcp origin middleware, and the WS upgrade authorizer. Before this
 * slice the two Hono closures captured the allowlist ARRAY VALUE at
 * createApp time while WS re-read per upgrade — the exact asymmetric
 * stale-drift the design review flagged. Every surface now accepts a
 * PROVIDER evaluated per request; each generation returns a NEW array so
 * the WeakMap pattern cache in web-origin-allowlist.ts keys correctly.
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { authorizeWsUpgrade } from '../routes/ws-auth.js'
import { createApiLoopbackCorsMiddleware } from './cors-loopback.js'
import { createMcpHttpOriginMiddleware } from './mcp-http.js'

const GRANTED = 'https://granted.example.com'

function makeProvider() {
  let generation: readonly string[] = []
  return {
    provider: () => generation,
    grant(origin: string) {
      // NEW array instance per generation — in-place append would defeat
      // the array-identity pattern cache in web-origin-allowlist.ts.
      generation = [...generation, origin]
    },
  }
}

describe('allowlist provider is evaluated per request on every surface', () => {
  it('/api CORS admits an origin granted after the middleware was created', async () => {
    const { provider, grant } = makeProvider()
    const app = new Hono()
    app.use('/api/*', createApiLoopbackCorsMiddleware(provider))
    app.get('/api/thing', (c) => c.json({ ok: true }))

    const run = async () => {
      const res = await app.request('/api/thing', {
        headers: { Origin: GRANTED, Host: '127.0.0.1:3099' },
      })
      return res.headers.get('access-control-allow-origin')
    }

    expect(await run()).toBeNull()
    grant(GRANTED)
    expect(await run()).toBe(GRANTED)
  })

  it('/mcp origin middleware admits an origin granted after creation', async () => {
    const { provider, grant } = makeProvider()
    const app = new Hono()
    app.use('/mcp', createMcpHttpOriginMiddleware(provider))
    app.post('/mcp', (c) => c.json({ ok: true }))

    const run = async () => {
      const res = await app.request('http://127.0.0.1:3099/mcp', {
        method: 'POST',
        headers: { Origin: GRANTED, Host: '127.0.0.1:3099' },
      })
      return res.status
    }

    expect(await run()).toBe(403)
    grant(GRANTED)
    expect(await run()).toBe(200)
  })

  it('WS upgrade admits an origin granted after the authorizer received the provider', () => {
    const { provider, grant } = makeProvider()
    const headers = { host: '127.0.0.1:3099', origin: GRANTED }

    expect(authorizeWsUpgrade(headers, undefined, provider)).toEqual({
      accept: false,
      statusCode: 403,
    })
    grant(GRANTED)
    expect(authorizeWsUpgrade(headers, undefined, provider).accept).toBe(true)
  })
})
