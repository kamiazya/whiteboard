import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findAvailablePort } from '../cli/daemon-run.js'
import { decodeBase64UrlText } from '../shared/api-contracts/pairing-link.js'
import {
  buildWhiteboardWsProtocolsWithTicket,
  WHITEBOARD_WS_PROTOCOL,
} from '../shared/ws-protocol.js'
import { type RunningServer, startHttpServer } from './http-server.js'
import { captureLogsForTests } from './log.js'
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
          'sec-websocket-protocol': 'whiteboard-v1, daemon-token.nope',
        },
        'secret',
      ),
    ).toEqual({ accept: false, statusCode: 401 })
  })

  it('accepts websocket upgrade with the daemon subprotocol token and selects whiteboard-v1', () => {
    expect(
      authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'http://127.0.0.1:5173',
          'sec-websocket-protocol': 'whiteboard-v1, daemon-token.secret',
        },
        'secret',
      ),
    ).toEqual({ accept: true, protocol: 'whiteboard-v1', scopes: ALL_AUTH_SCOPES })
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
          'sec-websocket-protocol': 'whiteboard-v1, daemon-token.secret',
        },
        'secret',
      ),
    ).toEqual({ accept: true, protocol: 'whiteboard-v1', scopes: ALL_AUTH_SCOPES })

    expect(
      authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'https://example.com',
          'sec-websocket-protocol': 'whiteboard-v1, daemon-token.secret',
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

// The wiring this covers: http-server.ts composes daemonBaseUrl from the
// bound host/port and threads it into createApp -> pairingLinkContext ->
// wb_pairing_link_create. app.test.ts only feeds createApp a hand-built
// daemonBaseUrl string, so a wrong interpolation in http-server.ts's own
// composition (wrong variable, dropped port, mismatched host) would pass
// every existing test green. This starts the real server via
// startHttpServer and calls the tool over the real socket to confirm the
// minted link's baseUrl actually matches the address the server bound.
describe('startHttpServer daemonBaseUrl -> wb_pairing_link_create wiring', () => {
  let running: RunningServer | undefined

  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  it('embeds the real bound host:port in the minted pairing link', async () => {
    const port = await findAvailablePort(4650)
    running = await startHttpServer({ port, host: '127.0.0.1' })

    const client = new Client({ name: 'http-server-pairing-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    await client.connect(transport)
    try {
      const res = await client.callTool({ name: 'wb_pairing_link_create', arguments: {} })
      expect(res.isError, JSON.stringify(res)).not.toBe(true)
      const result = res.structuredContent as { url: string }
      const fragment = result.url.split('#wb=')[1]
      const decoded = JSON.parse(decodeBase64UrlText(fragment ?? '')) as { baseUrl: string }
      expect(decoded.baseUrl).toBe(`http://127.0.0.1:${port}`)
    } finally {
      await transport.close()
    }
  })
})

// Performs a raw WS handshake offering an arbitrary Sec-WebSocket-Protocol
// value and resolves with the response status code, mirroring
// attemptWsUpgrade above but with a caller-controlled protocol header (needed
// to offer a minted ticket rather than the fixed daemon-token protocol).
function attemptWsUpgradeWithProtocol(port: number, protocolHeader: string): Promise<number> {
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
        'Sec-WebSocket-Protocol': protocolHeader,
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

function readSessionCookie(res: Response): string {
  const raw = res.headers.get('set-cookie')
  if (!raw) throw new Error('expected an approval-session cookie')
  const match = /(?:^|,\s*)([^=;,\s]+)=([^;]+)/.exec(raw)
  if (!match) throw new Error(`unparseable Set-Cookie: ${raw}`)
  return `${match[1]}=${match[2]}`
}

function readHiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html)
  if (!match?.[1]) throw new Error(`missing hidden field ${name}`)
  return match[1]
}

// The wiring this covers: http-server.ts creates exactly one wsTicketStore
// and threads it two ways -- into createApp (POST /api/ws-ticket mints into
// it) and directly into the raw `upgrade` handler's authorizeWsUpgrade call
// (which redeems it). Every other ws-ticket test constructs the router and
// authorizeWsUpgrade directly against a manually-shared store, which cannot
// catch a regression where http-server.ts accidentally wires two separate
// store instances -- this test starts the real server and drives the whole
// mint-then-upgrade path exactly as a hosted-origin client would.
describe('startHttpServer ws-ticket mint→upgrade wiring (ADR-0005)', () => {
  let running: RunningServer | undefined

  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  it('a ticket minted via POST /api/ws-ticket on the real server authorizes the real WS upgrade', async () => {
    const port = await findAvailablePort(4400)
    const clientId = 'whiteboard-hosted-web'
    const redirectUri = 'https://whiteboard.pages.dev/oauth/callback'
    const origin = `http://127.0.0.1:${port}`
    const pkceVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const pkceChallenge = createHash('sha256').update(pkceVerifier).digest('base64url')

    running = await startHttpServer({
      port,
      host: '127.0.0.1',
      oauthClientRegistry: [{ clientId, redirectUris: [redirectUri] }],
    })

    const authorizeParams = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state: 'state-abc',
      code_challenge: pkceChallenge,
      code_challenge_method: 'S256',
      scope: 'canvas:read',
    })
    const authorizeRes = await fetch(`${origin}/authorize?${authorizeParams.toString()}`)
    const authorizeHtml = await authorizeRes.text()
    const cookie = readSessionCookie(authorizeRes)
    const transactionId = readHiddenField(authorizeHtml, 'transaction_id')
    const csrfToken = readHiddenField(authorizeHtml, 'csrf_token')

    const decisionRes = await fetch(`${origin}/authorize/decision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        origin,
        cookie,
      },
      body: new URLSearchParams({
        transaction_id: transactionId,
        csrf_token: csrfToken,
        decision: 'approve',
      }).toString(),
      redirect: 'manual',
    })
    const code = new URL(decisionRes.headers.get('location') ?? '').searchParams.get('code')
    expect(code).toBeTruthy()

    const tokenRes = await fetch(`${origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: pkceVerifier,
      }).toString(),
    })
    expect(tokenRes.status).toBe(200)
    const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string }

    const ticketRes = await fetch(`${origin}/api/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(ticketRes.status).toBe(200)
    const { ticket } = (await ticketRes.json()) as { ticket: string }

    const protocolHeader = buildWhiteboardWsProtocolsWithTicket(ticket).join(', ')
    await expect(attemptWsUpgradeWithProtocol(port, protocolHeader)).resolves.toBe(101)
  })
})

// Wiring this covers: startHttpServer must construct exactly one file-gc
// sweeper and start it, and close() must stop it exactly once even if close()
// is (accidentally or deliberately) called twice -- the periodic sweep is
// otherwise invisible from outside the daemon (no HTTP surface), so only a
// test that drives the real startHttpServer/close() path can catch a
// regression where the sweeper is never started, started twice, or never
// stopped on shutdown.
describe('startHttpServer file-gc sweeper wiring', () => {
  let running: RunningServer | undefined

  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  it('creates exactly one sweeper, starts it once, and close() stops it exactly once', async () => {
    const port = await findAvailablePort(4500)
    let factoryCalls = 0
    let startCalls = 0
    let stopCalls = 0
    const fileGcSweeperFactory = () => {
      factoryCalls += 1
      return {
        start: () => {
          startCalls += 1
        },
        tick: async () => {},
        stop: async () => {
          stopCalls += 1
        },
      }
    }

    running = await startHttpServer({ port, host: '127.0.0.1', fileGcSweeperFactory })

    // Drive a real request through the server before closing it -- @hono/
    // node-server's serve() returns before the underlying socket has
    // finished its async bind, and closing before any request has been
    // dispatched can race Node's http.Server into treating itself as
    // "not running" yet. Every other startHttpServer test in this file
    // exercises a real request first for the same reason.
    const res = await fetch(`http://127.0.0.1:${port}/token`, { method: 'POST' })
    expect(res.status).toBe(404)

    expect(factoryCalls).toBe(1)
    expect(startCalls).toBe(1)
    expect(stopCalls).toBe(0)

    await running.close()
    expect(stopCalls).toBe(1)

    // Double close must not stop the sweeper a second time.
    await running.close()
    expect(stopCalls).toBe(1)
  })

  // Regression for a close() that is invoked twice CONCURRENTLY (idle timeout
  // racing an explicit shutdown route, for example) rather than only after
  // the first call has fully resolved -- a naive `if (closing) return` guard
  // lets the second call resolve immediately while the listener and
  // WebSockets are still tearing down, which is materially worse now that
  // shutdown can also be waiting on an in-flight GC pass.
  it('two concurrent close() calls share one shutdown promise instead of the second resolving early', async () => {
    const port = await findAvailablePort(4500)
    let stopCalls = 0
    let resolveStop: (() => void) | undefined
    const stopGate = new Promise<void>((resolve) => {
      resolveStop = resolve
    })
    const fileGcSweeperFactory = () => ({
      start: () => {},
      tick: async () => {},
      stop: async () => {
        stopCalls += 1
        await stopGate
      },
    })

    running = await startHttpServer({ port, host: '127.0.0.1', fileGcSweeperFactory })
    const res = await fetch(`http://127.0.0.1:${port}/token`, { method: 'POST' })
    expect(res.status).toBe(404)

    let firstResolved = false
    let secondResolved = false
    const first = running.close().then(() => {
      firstResolved = true
    })
    const second = running.close().then(() => {
      secondResolved = true
    })

    // Give queued microtasks a chance to run -- neither call may resolve
    // while the shared shutdown is gated on stopGate.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(firstResolved).toBe(false)
    expect(secondResolved).toBe(false)
    expect(stopCalls).toBe(1)

    resolveStop?.()
    await Promise.all([first, second])
    expect(firstResolved).toBe(true)
    expect(secondResolved).toBe(true)
    expect(stopCalls).toBe(1)
  })
})

// Regression: a losing port-bind race used to surface as a raw, unhandled
// 'error' event -- a Node stack trace dumped to the process's stdio. The
// loser must log one classified, sanitized record and exit instead of
// crashing with a stack trace that could leak filesystem paths.
describe('startHttpServer bind-failure handling', () => {
  it('logs a classified EADDRINUSE record with no stack trace and exits instead of throwing', async () => {
    const port = await findAvailablePort(4600)
    const occupier = createServer()
    await new Promise<void>((resolve) => occupier.listen(port, '127.0.0.1', resolve))
    const capture = captureLogsForTests()
    const exitCalls: number[] = []
    const exitProcess = (code: number) => {
      exitCalls.push(code)
    }
    let fileGcSweeperStopCalls = 0
    const fileGcSweeperFactory = () => ({
      start: () => {},
      tick: async () => {},
      stop: async () => {
        fileGcSweeperStopCalls += 1
      },
    })

    try {
      await startHttpServer({ port, host: '127.0.0.1', exitProcess, fileGcSweeperFactory })
      // Give the async bind failure's 'error' event a chance to fire.
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(exitCalls).toEqual([1])
      const errorRecord = capture.records.find((r) => r.level === 'error')
      expect(errorRecord).toBeDefined()
      expect(errorRecord?.data?.code).toBe('EADDRINUSE')
      expect(errorRecord?.data?.port).toBe(port)
      const serialized = JSON.stringify(errorRecord)
      expect(serialized).not.toMatch(/at .*:\d+:\d+/)
      expect(serialized).not.toContain('/Users/')
      expect(serialized).not.toContain('/home/')

      // Because `exitProcess` is a test stub rather than the real
      // process.exit(), the bind-failure handler must stop the idle timer
      // and GC sweeper itself -- otherwise they leak as dangling timers in
      // this test worker process for the real 15-min/24h durations.
      expect(fileGcSweeperStopCalls).toBe(1)
    } finally {
      capture.restore()
      await new Promise<void>((resolve) => occupier.close(() => resolve()))
    }
  })
})

describe('workspace tail wiring', () => {
  const ENV = 'WHITEBOARD_WORKSPACE_TAIL_MS'
  let running: Awaited<ReturnType<typeof startHttpServer>> | undefined
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env[ENV]
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env[ENV]
    else process.env[ENV] = previous
    await running?.close()
    running = undefined
  })

  function countingTailFactory() {
    const counts = { created: 0, started: 0, stopped: 0 }
    const factory = () => {
      counts.created += 1
      return {
        pollOnce: async () => {},
        start: () => {
          counts.started += 1
        },
        stop: async () => {
          counts.stopped += 1
        },
      }
    }
    return { counts, factory }
  }

  /**
   * The default is OFF, and this is the assertion that keeps it that way. A
   * tail running in every single-daemon install would poll the database
   * forever for a second instance nobody deployed, and nothing else here
   * would notice.
   */
  it('creates no tail when the interval is unset', async () => {
    delete process.env[ENV]
    const port = await findAvailablePort(4600)
    const { counts, factory } = countingTailFactory()
    running = await startHttpServer({
      port,
      host: '127.0.0.1',
      workspaceTailFactory: factory,
    })
    await fetch(`http://127.0.0.1:${port}/api/runtime/ping`)
    expect(counts.created).toBe(0)
  })

  it('creates, starts and stops exactly one tail when the interval is set', async () => {
    process.env[ENV] = '250'
    const port = await findAvailablePort(4610)
    const { counts, factory } = countingTailFactory()
    running = await startHttpServer({
      port,
      host: '127.0.0.1',
      workspaceTailFactory: factory,
    })
    await fetch(`http://127.0.0.1:${port}/api/runtime/ping`)
    expect(counts.created).toBe(1)
    expect(counts.started).toBe(1)
    expect(counts.stopped).toBe(0)

    await running.close()
    running = undefined
    expect(counts.stopped).toBe(1)
  })
})

/**
 * ADR-0021 decision 4's wiring. The scheduler's own tests cover when and
 * where; what only composition can answer is whether it is CONNECTED — and a
 * durability feature that is built and never started is the failure mode this
 * whole area exists to remove, since every unit test passes by calling it
 * directly.
 */
describe('startHttpServer: backup scheduler wiring', () => {
  const DIR_ENV = 'WHITEBOARD_BACKUP_DIR'
  let running: Awaited<ReturnType<typeof startHttpServer>> | undefined
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env[DIR_ENV]
  })
  afterEach(async () => {
    if (previous === undefined) delete process.env[DIR_ENV]
    else process.env[DIR_ENV] = previous
    await running?.close()
    running = undefined
  })

  function countingSchedulerFactory() {
    const counts = { created: 0, started: 0, stopped: 0 }
    const seen: Array<string | null> = []
    const factory = (options: { backupDir: string | null }) => {
      counts.created += 1
      seen.push(options.backupDir)
      return {
        start: () => {
          counts.started += 1
        },
        stop: async () => {
          counts.stopped += 1
        },
        runOnceForTests: async () => {},
      }
    }
    return { counts, seen, factory }
  }

  /**
   * Constructed either way — the scheduler decides for itself that a null
   * destination means do nothing — but it must be told the destination is
   * absent rather than being handed a guessed one.
   */
  it('passes a null destination through when nothing is configured', async () => {
    delete process.env[DIR_ENV]
    const port = await findAvailablePort(4620)
    const { counts, seen, factory } = countingSchedulerFactory()
    running = await startHttpServer({
      port,
      host: '127.0.0.1',
      backupSchedulerFactory: factory as never,
    })
    await fetch(`http://127.0.0.1:${port}/api/runtime/ping`)
    expect(counts.created).toBe(1)
    expect(seen).toEqual([null])
  })

  it('starts and stops exactly one scheduler when a destination is set', async () => {
    process.env[DIR_ENV] = '/srv/whiteboard-backups'
    const port = await findAvailablePort(4630)
    const { counts, seen, factory } = countingSchedulerFactory()
    running = await startHttpServer({
      port,
      host: '127.0.0.1',
      backupSchedulerFactory: factory as never,
    })
    await fetch(`http://127.0.0.1:${port}/api/runtime/ping`)
    expect(counts.created).toBe(1)
    expect(counts.started).toBe(1)
    expect(counts.stopped).toBe(0)
    expect(seen).toEqual(['/srv/whiteboard-backups'])

    await running.close()
    running = undefined
    expect(counts.stopped).toBe(1)
  })
})
