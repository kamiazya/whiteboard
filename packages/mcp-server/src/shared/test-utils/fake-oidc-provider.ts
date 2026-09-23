/**
 * An OpenID provider for tests that SIGNS and CHECKS for real: fresh RSA
 * keys, discovery and JWKS documents, and a token endpoint that refuses a
 * PKCE verifier not matching the challenge. It answers through openid-client's
 * `customFetch`, so no port is opened, and the relying party's own validation
 * is what gets exercised.
 */
import { createHash } from 'node:crypto'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import type { CustomFetch } from 'openid-client'

export interface FakeOidcProvider {
  readonly fetch: CustomFetch
  /** What the provider will say about the next person to finish signing in. */
  next(claims: Record<string, unknown>, overrides?: { nonce?: string }): void
  /** Plays the browser's trip to the provider: answers with the callback URL. */
  authorize(authorizationUrl: string): string
}

interface Grant {
  readonly nonce: string
  readonly challenge: string
  readonly claims: Record<string, unknown>
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function discoveryDocument(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
  }
}

async function tokenResponse(
  grant: Grant | undefined,
  verifier: string,
  sign: (grant: Grant) => Promise<string>,
): Promise<Response> {
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  if (grant === undefined || challenge !== grant.challenge) {
    return json({ error: 'invalid_grant' }, 400)
  }
  return json({
    access_token: 'at',
    token_type: 'Bearer',
    expires_in: 300,
    id_token: await sign(grant),
  })
}

function callbackFor(authorizationUrl: URL, code: string, issuer: string): string {
  const back = new URL(authorizationUrl.searchParams.get('redirect_uri') as string)
  back.searchParams.set('code', code)
  back.searchParams.set('state', authorizationUrl.searchParams.get('state') as string)
  back.searchParams.set('iss', issuer)
  return back.toString()
}

export async function fakeOidcProvider(
  issuer: string,
  clientId: string,
): Promise<FakeOidcProvider> {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  let pending: { claims: Record<string, unknown>; nonce?: string } = { claims: {} }
  const codes = new Map<string, Grant>()

  const sign = (grant: Grant) => {
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({ ...grant.claims, nonce: grant.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey)
  }

  return {
    next(claims, overrides) {
      pending = { claims, ...(overrides?.nonce === undefined ? {} : { nonce: overrides.nonce }) }
    },
    authorize(authorizationUrl) {
      const url = new URL(authorizationUrl)
      const code = `code-${codes.size + 1}-${Math.random().toString(36).slice(2)}`
      const nonce = pending.nonce ?? (url.searchParams.get('nonce') as string)
      codes.set(code, {
        nonce,
        challenge: url.searchParams.get('code_challenge') as string,
        claims: pending.claims,
      })
      return callbackFor(url, code, issuer)
    },
    fetch: async (target, init) => {
      const { pathname } = new URL(target)
      if (pathname === '/.well-known/openid-configuration') return json(discoveryDocument(issuer))
      if (pathname === '/jwks') return json({ keys: [jwk] })
      if (pathname !== '/token') return json({ error: 'not_found' }, 404)
      const body = new URLSearchParams(String(init.body ?? ''))
      const grant = codes.get(body.get('code') ?? '')
      codes.delete(body.get('code') ?? '')
      return tokenResponse(grant, body.get('code_verifier') ?? '', sign)
    },
  }
}
