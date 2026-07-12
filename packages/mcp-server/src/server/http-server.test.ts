import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { findAvailablePort } from '../cli/daemon-run.js'
import { WHITEBOARD_WS_PROTOCOL } from '../shared/ws-protocol.js'
import { type RunningServer, startHttpServer } from './http-server.js'
import { authorizeWsUpgrade } from './routes/ws-auth.js'
import { ALL_AUTH_SCOPES } from './security/auth-strategy.js'

describe('authorizeWsUpgrade', () => {
  it('rejects websocket upgrade without the daemon subprotocol token when token auth is enabled', () => {
    expect(
      authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
        },
        'secret',
      ),
    ).toEqual({ accept: false, statusCode: 401 })
  })

  it('rejects websocket upgrade when the daemon subprotocol token is wrong', () => {
    expect(
      authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          'sec-websocket-protocol': 'excalidraw-v1, daemon-token.nope',
        },
        'secret',
      ),
    ).toEqual({ accept: false, statusCode: 401 })
  })

  it('accepts websocket upgrade with the daemon subprotocol token and selects excalidraw-v1', () => {
    expect(
      authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'http://127.0.0.1:5173',
          'sec-websocket-protocol': 'excalidraw-v1, daemon-token.secret',
        },
        'secret',
      ),
    ).toEqual({ accept: true, protocol: 'excalidraw-v1', scopes: ALL_AUTH_SCOPES })
  })

  it('keeps websocket auth disabled when daemon token is unset', () => {
    expect(
      authorizeWsUpgrade({
        host: '127.0.0.1:3099',
      }),
    ).toEqual({ accept: true, protocol: undefined, scopes: ALL_AUTH_SCOPES })
  })

  it('admits cross-name loopback origins but rejects non-loopback ones', () => {
    // Loopback-to-loopback name mismatch (localhost page, 127.0.0.1 daemon)
    // is admitted — same policy as the HTTP CORS middleware; the token is
    // still required and offered here.
    expect(
      authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'http://localhost:5173',
          'sec-websocket-protocol': 'excalidraw-v1, daemon-token.secret',
        },
        'secret',
      ),
    ).toEqual({ accept: true, protocol: 'excalidraw-v1', scopes: ALL_AUTH_SCOPES })

    expect(
      authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'https://example.com',
          'sec-websocket-protocol': 'excalidraw-v1, daemon-token.secret',
        },
        'secret',
      ),
    ).toEqual({ accept: false, statusCode: 403 })
  })
})

// Attempts a raw WS handshake and resolves with the response status code:
// either the HTTP upgrade response (101 on accept) or the plain HTTP
// rejection response the 'upgrade' handler writes by hand for a refusal.
function attemptWsUpgrade(port: number, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/ws/ws_test/canvas',
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Protocol': WHITEBOARD_WS_PROTOCOL,
        Origin: origin,
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('startHttpServer WS upgrade with allowedWebOrigins', () => {
  let running: RunningServer | undefined

  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  it('threads allowedWebOrigins through to the real WS upgrade handler', async () => {
    const port = await findAvailablePort(4100)
    const hostedOrigin = 'https://kamiazya-whiteboard.pages.dev'
    running = await startHttpServer({
      port,
      host: '127.0.0.1',
      allowedWebOrigins: [hostedOrigin],
    })

    // Listed hosted origin is admitted -- proves the option reached the
    // real Node HTTP upgrade handler, not just the pure authorizeWsUpgrade
    // unit under test above.
    await expect(attemptWsUpgrade(port, hostedOrigin)).resolves.toBe(101)

    // An origin absent from the allowlist is still refused, confirming the
    // allowlist is actually consulted rather than the upgrade path always
    // accepting.
    await expect(attemptWsUpgrade(port, 'https://not-allowed.example')).resolves.toBe(403)
  })
})

describe('startHttpServer oauth client registry', () => {
  let running: RunningServer | undefined

  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  // The router, its Zod schemas, and its unit tests can all be correct while
  // the surface stays unreachable, because createApp only mounts it when it
  // is handed a registry. This asserts the option actually reaches the real
  // Node HTTP server — the difference between a shipped endpoint and dead code.
  it('mounts /token on the real HTTP server when a registry is configured', async () => {
    const port = await findAvailablePort(4200)
    running = await startHttpServer({
      port,
      host: '127.0.0.1',
      oauthClientRegistry: [
        {
          clientId: 'whiteboard-hosted-web',
          redirectUris: ['https://whiteboard.pages.dev/oauth/callback'],
        },
      ],
    })

    // RFC 6749 §4.1.3's wire format, over a real socket. An unmounted route
    // would 404; reaching the handler with an unknown code is a 400
    // invalid_grant, which is what proves the body was parsed at all.
    const res = await fetch(`http://127.0.0.1:${port}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'not-a-real-code',
        redirect_uri: 'https://whiteboard.pages.dev/oauth/callback',
        client_id: 'whiteboard-hosted-web',
        code_verifier: 'x'.repeat(43),
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_grant' })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('leaves /token unmounted when no registry is configured', async () => {
    const port = await findAvailablePort(4300)
    running = await startHttpServer({ port, host: '127.0.0.1' })

    const res = await fetch(`http://127.0.0.1:${port}/token`, { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
