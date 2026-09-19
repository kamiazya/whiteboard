import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { mintMacaroon } from '../security/macaroon.js'
import { createDaemonAuthMiddleware } from './auth.js'

const ROOT_KEY = new Uint8Array(32).fill(3)
const OTHER_ROOT_KEY = new Uint8Array(32).fill(4)
const DAEMON_TOKEN = 'the-daemon-token'

// Real routes, so the scopes come from `route-scope-registry.ts` rather than
// from a fixture that could drift from it. Read is `canvas:read`, write is
// `canvas:write`; the registry is what decides, and that is the point.
const READ_PATH = '/api/w/ws-alpha/document/board'
const WRITE = { method: 'PUT', path: '/api/w/ws-alpha/document/board' } as const

function app(macaroonRootKey?: Uint8Array) {
  const instance = new Hono()
  instance.use(
    '/api/*',
    createDaemonAuthMiddleware(DAEMON_TOKEN, undefined, undefined, macaroonRootKey),
  )
  instance.all('/api/*', (c) => c.json({ ok: true }))
  return instance
}

const get = (instance: Hono, path: string, bearer?: string) =>
  instance.request(path, {
    headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
  })

const put = (instance: Hono, path: string, bearer: string) =>
  instance.request(path, {
    method: 'PUT',
    headers: { authorization: `Bearer ${bearer}` },
  })

describe('the daemon /api guard — a macaroon is checked against the route scope', () => {
  it('admits a macaroon whose caveat covers the route', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    expect((await get(app(ROOT_KEY), READ_PATH, token)).status).toBe(200)
  })

  // The whole increment: for the first time in local-daemon mode, a
  // credential is refused on the SCOPE the registry declares rather than on
  // whether it is the daemon token.
  it('refuses a macaroon caveated below what the route declares', async () => {
    const readOnly = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    const response = await put(app(ROOT_KEY), WRITE.path, readOnly)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' })
  })

  it('admits the same holder once the caveat covers the write', async () => {
    const readWrite = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read', 'canvas:write'] }],
    })

    expect((await put(app(ROOT_KEY), WRITE.path, readWrite)).status).toBe(200)
  })

  it('refuses a macaroon minted under a different root key', async () => {
    const foreign = await mintMacaroon({
      rootKey: OTHER_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    expect((await get(app(ROOT_KEY), READ_PATH, foreign)).status).toBe(401)
  })

  it('refuses an expired macaroon', async () => {
    const expired = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [
        { kind: 'scope', scopes: ['canvas:read'] },
        { kind: 'expiresAt', epochMs: 0 },
      ],
    })

    expect((await get(app(ROOT_KEY), READ_PATH, expired)).status).toBe(401)
  })

  // Nothing mints a workspace-caveated macaroon yet and the middleware does
  // not thread the path's workspace through, so such a token fails closed.
  // Pinned so the next slice has to notice it rather than discover it.
  it('fails closed on a workspace caveat, which is not threaded through yet', async () => {
    const scoped = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [
        { kind: 'scope', scopes: ['canvas:read'] },
        { kind: 'workspace', workspaceId: 'ws-alpha' },
      ],
    })

    expect((await get(app(ROOT_KEY), READ_PATH, scoped)).status).toBe(401)
  })
})

describe('the daemon /api guard — what a macaroon must not change', () => {
  it('leaves the daemon token authorizing every route, unscoped as before', async () => {
    const instance = app(ROOT_KEY)

    expect((await get(instance, READ_PATH, DAEMON_TOKEN)).status).toBe(200)
    expect((await put(instance, WRITE.path, DAEMON_TOKEN)).status).toBe(200)
  })

  it('carries no macaroon branch at all when no root key is supplied', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    expect((await get(app(undefined), READ_PATH, token)).status).toBe(401)
    // …and the daemon token still works in that configuration.
    expect((await get(app(undefined), READ_PATH, DAEMON_TOKEN)).status).toBe(200)
  })

  it('still refuses a request with no credential at all', async () => {
    expect((await get(app(ROOT_KEY), READ_PATH)).status).toBe(401)
  })

  it('answers every refusal identically, so no branch is distinguishable', async () => {
    const instance = app(ROOT_KEY)
    const readOnly = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })
    const foreign = await mintMacaroon({ rootKey: OTHER_ROOT_KEY, tokenId: 'agent-1' })

    const refusals = await Promise.all([
      get(instance, READ_PATH),
      get(instance, READ_PATH, 'not-a-token'),
      get(instance, READ_PATH, foreign),
      put(instance, WRITE.path, readOnly),
    ])

    for (const response of refusals) {
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'unauthorized' })
    }
  })

  it('leaves a public route reachable with no credential', async () => {
    expect((await get(app(ROOT_KEY), '/api/runtime/ping')).status).toBe(200)
  })
})
