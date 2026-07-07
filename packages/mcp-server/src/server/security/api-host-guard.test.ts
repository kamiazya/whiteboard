import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createApiHostGuardMiddleware } from './api-host-guard.js'

// The host guard is the primary defense against DNS-rebinding attacks reaching
// /api/* in local-daemon mode: a browser tab on an attacker-controlled domain
// can still resolve to 127.0.0.1, but the Host header it sends stays the
// attacker's hostname, so this guard can reject it before any auth check runs.

function buildApp(mode: 'local-daemon' | 'server-mode') {
  const app = new Hono()
  app.use('/api/*', createApiHostGuardMiddleware(mode))
  app.get('/api/thing', (c) => c.json({ ok: true }))
  app.options('/api/thing', (c) => c.body(null, 204))
  return app
}

describe('createApiHostGuardMiddleware', () => {
  it('rejects a spoofed non-loopback Host with 403 in local-daemon mode', async () => {
    const app = buildApp('local-daemon')
    const res = await app.request('/api/thing', { headers: { Host: 'evil.example' } })
    expect(res.status).toBe(403)
  })

  it('allows a loopback Host in local-daemon mode', async () => {
    const app = buildApp('local-daemon')
    const res = await app.request('/api/thing', { headers: { Host: '127.0.0.1:3099' } })
    expect(res.status).toBe(200)
  })

  it('rejects an unparsable Host header in local-daemon mode', async () => {
    const app = buildApp('local-daemon')
    const res = await app.request('/api/thing', { headers: { Host: 'evil example' } })
    expect(res.status).toBe(403)
  })

  it('rejects a spoofed Host on OPTIONS before any CORS short-circuit', async () => {
    const app = buildApp('local-daemon')
    const res = await app.request('/api/thing', {
      method: 'OPTIONS',
      headers: { Host: 'evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('passes through unconditionally in server-mode', async () => {
    const app = buildApp('server-mode')
    const res = await app.request('/api/thing', { headers: { Host: 'evil.example' } })
    expect(res.status).toBe(200)
  })
})
