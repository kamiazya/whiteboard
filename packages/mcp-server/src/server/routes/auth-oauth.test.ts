import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createOAuthTransactionStore } from '../security/oauth-authz-transactions.js'
import { createDaemonAuthMiddleware } from './auth.js'

const DAEMON_TOKEN = 'daemon-token'

function createApp(grantStore?: ReturnType<typeof createOAuthTransactionStore>) {
  const app = new Hono()
  app.use('/api/*', createDaemonAuthMiddleware(DAEMON_TOKEN, grantStore))
  app.all('/api/*', (c) => c.json({ ok: true }))
  return app
}

const READ_PATH = '/api/canvas/session-1/demo/snapshot'
const WRITE_PATH = '/api/canvas/session-1/demo/update'
const UNDECLARED_PATH = '/api/not-in-the-registry'

async function request(
  app: Hono,
  path: string,
  method: string,
  bearer?: string,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  })
}

describe('createDaemonAuthMiddleware with an OAuth grant store', () => {
  it('keeps accepting the daemon token with full authority on read and write', async () => {
    const app = createApp(createOAuthTransactionStore())

    expect((await request(app, READ_PATH, 'GET', DAEMON_TOKEN)).status).toBe(200)
    expect((await request(app, WRITE_PATH, 'POST', DAEMON_TOKEN)).status).toBe(200)
  })

  it('accepts an OAuth access token on a route its grant covers', async () => {
    const store = createOAuthTransactionStore()
    const { accessToken } = store.mintAccessToken(['canvas:read'], 'hosted-client')

    expect((await request(createApp(store), READ_PATH, 'GET', accessToken)).status).toBe(200)
  })

  it('refuses a read-only grant on a write route, indistinguishably from no credential', async () => {
    const store = createOAuthTransactionStore()
    const { accessToken } = store.mintAccessToken(['canvas:read'], 'hosted-client')
    const app = createApp(store)

    const responses = await Promise.all([
      request(app, WRITE_PATH, 'POST', accessToken),
      request(app, WRITE_PATH, 'POST'),
      request(app, WRITE_PATH, 'POST', 'garbage'),
      request(app, WRITE_PATH, 'POST', 'daemon-token-but-wrong'),
    ])

    // A caller must not be able to tell an insufficient-scope grant from a
    // missing credential, a forged bearer, or a wrong daemon token.
    const observed = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: await response.json(),
        challenge: response.headers.get('www-authenticate'),
      })),
    )
    for (const outcome of observed) {
      expect(outcome).toEqual({ status: 401, body: { error: 'unauthorized' }, challenge: null })
    }
  })

  it('accepts a write-scoped grant on the same write route', async () => {
    const store = createOAuthTransactionStore()
    const { accessToken } = store.mintAccessToken(['canvas:read', 'canvas:write'], 'hosted-client')

    expect((await request(createApp(store), WRITE_PATH, 'POST', accessToken)).status).toBe(200)
  })

  it('refuses an expired grant', async () => {
    let clock = 1_000
    const store = createOAuthTransactionStore({ now: () => clock })
    const { accessToken, expiresIn } = store.mintAccessToken(['canvas:read'], 'hosted-client')
    clock += expiresIn * 1000 + 1

    expect((await request(createApp(store), READ_PATH, 'GET', accessToken)).status).toBe(401)
  })

  it('refuses a revoked grant', async () => {
    const store = createOAuthTransactionStore()
    const { accessToken } = store.mintAccessToken(['canvas:read'], 'hosted-client')
    store.revokeGrant(store.listGrants('hosted-client')[0].grantId)

    expect((await request(createApp(store), READ_PATH, 'GET', accessToken)).status).toBe(401)
  })

  it('fails closed on an undeclared /api route even for a fully-scoped grant', async () => {
    const store = createOAuthTransactionStore()
    const { accessToken } = store.mintAccessToken(
      ['canvas:read', 'canvas:write', 'workspace:read', 'workspace:write'],
      'hosted-client',
    )
    const app = createApp(store)

    expect((await request(app, UNDECLARED_PATH, 'GET', accessToken)).status).toBe(401)
    // The daemon token is not scope-gated and keeps its unchanged authority.
    expect((await request(app, UNDECLARED_PATH, 'GET', DAEMON_TOKEN)).status).toBe(200)
  })

  it('leaves the daemon-token-only wiring (no grant store) unchanged', async () => {
    const store = createOAuthTransactionStore()
    const { accessToken } = store.mintAccessToken(['canvas:read'], 'hosted-client')
    const app = createApp()

    expect((await request(app, READ_PATH, 'GET', DAEMON_TOKEN)).status).toBe(200)
    expect((await request(app, READ_PATH, 'GET', accessToken)).status).toBe(401)
  })

  it('leaves /api/runtime/ping open', async () => {
    expect(
      (await request(createApp(createOAuthTransactionStore()), '/api/runtime/ping', 'GET')).status,
    ).toBe(200)
  })

  // Coverage gap, recorded rather than papered over: this suite previously
  // had a case exercising the `daemon-token-only` RouteScopeDecision variant
  // (never satisfiable by any OAuth grant, only the literal daemon token)
  // through /api/reconnect-credential. That route was removed along with the
  // rest of the silent-reconnect surface, and no other route currently
  // produces `daemon-token-only` — the variant's refusal branch in
  // isAuthorizedOAuthGrant (auth.ts) is reachable only from a future route
  // that declares it, and has no live coverage until one exists.
})
