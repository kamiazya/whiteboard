import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createOAuthTransactionStore } from '../security/oauth-authz-transactions.js'
import { createOAuthAuthzRouter } from './oauth-authz.js'

const CLIENT_ID = 'whiteboard-hosted-web'
const REDIRECT_URI = 'https://whiteboard.pages.dev/oauth/callback'
const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const PKCE_CHALLENGE = createHash('sha256').update(PKCE_VERIFIER).digest('base64url')

function buildApp() {
  const store = createOAuthTransactionStore()
  const registry = [{ clientId: CLIENT_ID, redirectUris: [REDIRECT_URI] }]
  const app = new Hono()
  app.route('/', createOAuthAuthzRouter({ store, registry }))
  return { app, store }
}

function issueCode(store: ReturnType<typeof createOAuthTransactionStore>) {
  const { transactionId } = store.createTransaction({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scopes: ['workspace:read'],
    state: 'abc123',
    codeChallenge: PKCE_CHALLENGE,
    codeChallengeMethod: 'S256',
  })
  store.approveTransaction(transactionId)
  const issued = store.issueAuthorizationCode(transactionId)
  if (!issued) throw new Error('expected issuance to succeed')
  return issued.code
}

describe('GET /.well-known/oauth-protected-resource/api', () => {
  it('returns RFC 9728 metadata for the /api resource', async () => {
    const { app } = buildApp()
    const res = await app.request('http://127.0.0.1:3099/.well-known/oauth-protected-resource/api')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ resource: 'http://127.0.0.1:3099/api' })
  })
})

describe('GET /.well-known/oauth-authorization-server', () => {
  it('returns RFC 8414 metadata', async () => {
    const { app } = buildApp()
    const res = await app.request('http://127.0.0.1:3099/.well-known/oauth-authorization-server')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ token_endpoint: 'http://127.0.0.1:3099/token' })
  })
})

describe('POST /token', () => {
  it('exchanges a valid code + verifier for an access token', async () => {
    const { app, store } = buildApp()
    const code = issueCode(store)
    const res = await app.request('http://127.0.0.1:3099/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: PKCE_VERIFIER,
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ token_type: 'Bearer' })
    expect(typeof body.access_token).toBe('string')
  })

  it('exchanges a form-encoded request — the wire format RFC 6749 §4.1.3 actually mandates', async () => {
    const { app, store } = buildApp()
    const code = issueCode(store)
    const res = await app.request('http://127.0.0.1:3099/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: PKCE_VERIFIER,
      }).toString(),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ token_type: 'Bearer' })
    expect(typeof body.access_token).toBe('string')
  })

  it('rejects a form-encoded request missing code_verifier', async () => {
    const { app, store } = buildApp()
    const code = issueCode(store)
    const res = await app.request('http://127.0.0.1:3099/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
      }).toString(),
    })
    expect(res.status).toBe(400)
  })

  it('sets Cache-Control: no-store on a successful token response — RFC 6749 §5.1', async () => {
    const { app, store } = buildApp()
    const code = issueCode(store)
    const res = await app.request('http://127.0.0.1:3099/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: PKCE_VERIFIER,
      }).toString(),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('sets Cache-Control: no-store on an error token response too — RFC 6749 §5.2', async () => {
    const { app } = buildApp()
    const res = await app.request('http://127.0.0.1:3099/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code',
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects a request with no code_verifier at all — trap #3, enforced server-side', async () => {
    const { app, store } = buildApp()
    const code = issueCode(store)
    const res = await app.request('http://127.0.0.1:3099/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
      }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a redirect_uri that is not byte-for-byte registered — trap #2', async () => {
    const { app, store } = buildApp()
    const code = issueCode(store)
    const res = await app.request('http://127.0.0.1:3099/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${REDIRECT_URI}/evil`,
        client_id: CLIENT_ID,
        code_verifier: PKCE_VERIFIER,
      }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_grant')
  })

  it('resolves two concurrent redemptions of the same code to exactly one success — trap #4', async () => {
    const { app, store } = buildApp()
    const code = issueCode(store)
    const requestOptions: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: PKCE_VERIFIER,
      }),
    }
    const [first, second] = await Promise.all([
      app.request('http://127.0.0.1:3099/token', requestOptions),
      app.request('http://127.0.0.1:3099/token', requestOptions),
    ])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 400])
  })
})
