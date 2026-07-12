import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createOAuthTransactionStore } from '../security/oauth-authz-transactions.js'
import { createOAuthAuthzRouter } from './oauth-authz.js'

const CLIENT_ID = 'whiteboard-hosted-web'
const REDIRECT_URI = 'https://whiteboard.pages.dev/oauth/callback'
const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const PKCE_CHALLENGE = createHash('sha256').update(PKCE_VERIFIER).digest('base64url')
const ORIGIN = 'http://127.0.0.1:3099'

function buildApp() {
  const store = createOAuthTransactionStore()
  const registry = [{ clientId: CLIENT_ID, redirectUris: [REDIRECT_URI] }]
  const app = new Hono()
  app.route('/', createOAuthAuthzRouter({ store, registry }))
  return { app, store }
}

function authorizeUrl(overrides: Record<string, string | undefined> = {}): string {
  const base: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: 'state-abc',
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'workspace:read canvas:read',
    ...overrides,
  }
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) params.set(key, value)
  }
  return `${ORIGIN}/authorize?${params.toString()}`
}

function readSessionCookie(res: Response): string {
  const raw = res.headers.get('set-cookie')
  if (!raw) throw new Error('expected an approval-session cookie')
  const value = /(?:^|,\s*)([^=;,\s]+)=([^;]+)/.exec(raw)
  if (!value) throw new Error(`unparseable Set-Cookie: ${raw}`)
  return `${value[1]}=${value[2]}`
}

function readHiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html)
  if (!match?.[1]) throw new Error(`missing hidden field ${name}`)
  return match[1]
}

async function startApproval(app: Hono) {
  const res = await app.request(authorizeUrl())
  const html = await res.text()
  return {
    res,
    html,
    cookie: readSessionCookie(res),
    transactionId: readHiddenField(html, 'transaction_id'),
    csrfToken: readHiddenField(html, 'csrf_token'),
  }
}

function decisionRequest(
  body: Record<string, string>,
  init: { cookie?: string; origin?: string | null } = {},
): [string, RequestInit] {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    'sec-fetch-site': 'same-origin',
  }
  if (init.cookie) headers.cookie = init.cookie
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN
  return [
    `${ORIGIN}/authorize/decision`,
    { method: 'POST', headers, body: new URLSearchParams(body).toString() },
  ]
}

describe('GET /authorize — client/redirect validation must never redirect', () => {
  it('renders a local error page for an unregistered client_id', async () => {
    const { app } = buildApp()
    const res = await app.request(authorizeUrl({ client_id: 'evil-client' }))
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).toContain('not registered')
  })

  it('renders a local error page for a redirect_uri that is not byte-for-byte registered', async () => {
    const { app } = buildApp()
    const res = await app.request(authorizeUrl({ redirect_uri: `${REDIRECT_URI}/evil` }))
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })
})

describe('GET /authorize — parameter errors redirect per RFC 6749 §4.1.2.1', () => {
  it('refuses a request with no code_challenge', async () => {
    const { app } = buildApp()
    const res = await app.request(authorizeUrl({ code_challenge: undefined }))
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.searchParams.get('error')).toBe('invalid_request')
    expect(location.searchParams.get('state')).toBe('state-abc')
  })

  it('refuses a downgrade to code_challenge_method=plain', async () => {
    const { app } = buildApp()
    const res = await app.request(
      authorizeUrl({ code_challenge: PKCE_VERIFIER, code_challenge_method: 'plain' }),
    )
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.searchParams.get('error')).toBe('invalid_request')
  })

  it('treats an omitted scope as invalid_scope, never a silent full grant', async () => {
    const { app } = buildApp()
    const res = await app.request(authorizeUrl({ scope: undefined }))
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.searchParams.get('error')).toBe('invalid_scope')
  })

  it('rejects a scope outside the vocabulary', async () => {
    const { app } = buildApp()
    const res = await app.request(authorizeUrl({ scope: 'workspace:read admin:everything' }))
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.searchParams.get('error')).toBe('invalid_scope')
  })
})

describe('GET /authorize — approval screen', () => {
  it('renders the approval form and binds a CSRF cookie without putting it in the URL', async () => {
    const { app } = buildApp()
    const { res, html, transactionId, csrfToken } = await startApproval(app)

    expect(res.status).toBe(200)
    expect(html).toContain('whiteboard.pages.dev')
    expect(transactionId).not.toHaveLength(0)
    expect(csrfToken).not.toHaveLength(0)

    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    // Plain http request: marking the cookie Secure would make it undeliverable.
    expect(setCookie).not.toContain('Secure')
    expect(res.headers.get('location')).toBeNull()
  })

  it('sends no-store, no-referrer, DENY and a frame-ancestors CSP', async () => {
    const { app } = buildApp()
    const { res } = await startApproval(app)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  it('rate-limits a client hammering the endpoint', async () => {
    const { app } = buildApp()
    let lastStatus = 0
    for (let i = 0; i < 12; i += 1) {
      const res = await app.request(authorizeUrl())
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
  })
})

describe('POST /authorize/decision', () => {
  it('approves: issues a code bound to the state and the registered redirect_uri', async () => {
    const { app } = buildApp()
    const { cookie, transactionId, csrfToken } = await startApproval(app)

    const res = await app.request(
      ...decisionRequest(
        { transaction_id: transactionId, csrf_token: csrfToken, decision: 'approve' },
        { cookie },
      ),
    )
    expect(res.status).toBe(303)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe(REDIRECT_URI)
    expect(location.searchParams.get('state')).toBe('state-abc')
    const code = location.searchParams.get('code')
    expect(code).toBeTruthy()
    expect(res.headers.get('cache-control')).toBe('no-store')

    const tokenRes = await app.request(`${ORIGIN}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: PKCE_VERIFIER,
      }).toString(),
    })
    expect(tokenRes.status).toBe(200)
    const token = (await tokenRes.json()) as { scope: string }
    expect(token.scope).toBe('workspace:read canvas:read')
  })

  it('denies: redirects with access_denied and never a code', async () => {
    const { app } = buildApp()
    const { cookie, transactionId, csrfToken } = await startApproval(app)

    const res = await app.request(
      ...decisionRequest(
        { transaction_id: transactionId, csrf_token: csrfToken, decision: 'deny' },
        { cookie },
      ),
    )
    expect(res.status).toBe(303)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('state')).toBe('state-abc')
    expect(location.searchParams.get('code')).toBeNull()
  })

  it('rejects a POST with the form field but no cookie', async () => {
    const { app } = buildApp()
    const { transactionId, csrfToken } = await startApproval(app)
    const res = await app.request(
      ...decisionRequest({
        transaction_id: transactionId,
        csrf_token: csrfToken,
        decision: 'approve',
      }),
    )
    expect(res.status).toBe(403)
    expect(res.headers.get('location')).toBeNull()
  })

  it('rejects a POST whose form field is not bound to the transaction', async () => {
    const { app } = buildApp()
    const { cookie, transactionId } = await startApproval(app)
    const res = await app.request(
      ...decisionRequest(
        { transaction_id: transactionId, csrf_token: 'forged-token', decision: 'approve' },
        { cookie },
      ),
    )
    expect(res.status).toBe(403)
  })

  it('rejects a cross-site POST even when the cookie rides along', async () => {
    const { app } = buildApp()
    const { cookie, transactionId, csrfToken } = await startApproval(app)
    const [url, init] = decisionRequest(
      { transaction_id: transactionId, csrf_token: csrfToken, decision: 'approve' },
      { cookie, origin: 'https://attacker.example' },
    )
    const res = await app.request(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), 'sec-fetch-site': 'cross-site' },
    })
    expect(res.status).toBe(403)
  })

  it('renders a start-again page when the transaction is gone (daemon restart)', async () => {
    const { app } = buildApp()
    const { cookie, csrfToken } = await startApproval(app)
    const res = await app.request(
      ...decisionRequest(
        { transaction_id: 'no-such-transaction', csrf_token: csrfToken, decision: 'approve' },
        { cookie },
      ),
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).toContain('Start the authorization request again')
  })

  it('refuses to issue a second code for an already-decided transaction', async () => {
    const { app } = buildApp()
    const { cookie, transactionId, csrfToken } = await startApproval(app)
    const form = { transaction_id: transactionId, csrf_token: csrfToken, decision: 'approve' }
    const first = await app.request(...decisionRequest(form, { cookie }))
    expect(first.status).toBe(303)
    const second = await app.request(...decisionRequest(form, { cookie }))
    expect(second.status).toBe(400)
    expect(second.headers.get('location')).toBeNull()
  })
})
