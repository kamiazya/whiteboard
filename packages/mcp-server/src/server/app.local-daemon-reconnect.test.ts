// Drives POST /api/reconnect-credential and POST /api/reconnect-session
// through the real createApp({ authMode: 'local-daemon' }) composition —
// reconnect.test.ts only exercises createReconnectRouter directly with
// hand-built options, so it never proves the production wiring in app.ts:
// the default `options.webOriginTrustStore ?? createWebOriginTrustStore()`
// fallback, the `token ?? ''` tokenless fallback, and interaction with the
// rest of the local-daemon middleware stack (CORS, host guard, daemon-token
// auth) ahead of these routes.

import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-app-local-daemon-reconnect-')

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  getDataDir: () => join(tmp.dir, 'data'),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { createApp } = await import('./app.js')

const ORIGIN = 'http://localhost:5173'

function baseOptions(token?: string) {
  return {
    authMode: 'local-daemon' as const,
    token,
    touch: () => {},
    shutdown: async () => undefined,
    allowedWebOrigins: [ORIGIN],
    getStatus: () => ({
      ok: true,
      pid: 1,
      host: '127.0.0.1',
      port: 3099,
      baseUrl: 'http://127.0.0.1:3099',
      version: '0.0.0',
      startedAt: new Date().toISOString(),
      uptimeMs: 0,
      idleForMs: 0,
      auth: { mode: 'local-token', hasToken: Boolean(token) },
      storage: { dataDir: tmp.dir, dataDirWritable: true },
      app: { served: true, buildPresent: false, ui: 'web-app' },
      mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
      clients: { connected: 0, ready: 0 },
    }),
  }
}

describe('createApp local-daemon reconnect wiring', () => {
  beforeEach(async () => {
    const { clearCache } = await import('./store/doc-cache.js')
    const { clearWorkspaceIdCache } = await import('./mcp/session-resolver.js')
    clearCache()
    clearWorkspaceIdCache()
  })

  it('enrolls and reconnects through the real app composition, with the default trust store', async () => {
    const token = 'daemon-token-value'
    const app = createApp(baseOptions(token))

    const enroll = await app.request('/api/reconnect-credential', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    })
    expect(enroll.status).toBe(200)
    const { reconnectSecret } = await enroll.json()
    expect(reconnectSecret).toEqual(expect.any(String))

    const reconnect = await app.request('/api/reconnect-session', {
      method: 'POST',
      headers: { authorization: `Bearer ${reconnectSecret}`, origin: ORIGIN },
    })
    expect(reconnect.status).toBe(200)
    const body = await reconnect.json()
    expect(body.token).toBe(token)
  })

  it('refuses enrollment without the daemon token, even from an admitted origin', async () => {
    const app = createApp(baseOptions('daemon-token-value'))

    const res = await app.request('/api/reconnect-credential', {
      method: 'POST',
      headers: { origin: ORIGIN },
    })
    expect(res.status).toBe(401)
  })

  it('tokenless local-daemon mode: reconnect-session hands back the empty token instead of 500ing', async () => {
    // No `token` in options — the same "auth is a no-op" dev mode every
    // other /api/* route has. reconnect-credential requires no auth in this
    // mode either (isAuthorized returns true for an undefined token).
    const app = createApp(baseOptions(undefined))

    const enroll = await app.request('/api/reconnect-credential', {
      method: 'POST',
      headers: { origin: ORIGIN },
    })
    expect(enroll.status).toBe(200)
    const { reconnectSecret } = await enroll.json()

    const reconnect = await app.request('/api/reconnect-session', {
      method: 'POST',
      headers: { authorization: `Bearer ${reconnectSecret}`, origin: ORIGIN },
    })
    expect(reconnect.status).toBe(200)
    const body = await reconnect.json()
    expect(body.token).toBe('')
  })
})
