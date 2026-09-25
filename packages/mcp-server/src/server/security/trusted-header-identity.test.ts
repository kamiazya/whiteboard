/**
 * ADR-0046 decision 2: who a trusted reverse proxy says is signing in. The
 * header is believed only from a declared peer address, and a signed
 * assertion only when the proxy's own key, issuer and audience all check.
 */
import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { signInConfigSchema, type TrustedHeaderProvider } from './sign-in-config.js'
import { createTrustedIdentityReader } from './trusted-header-identity.js'

const ISSUER = 'https://team.cloudflareaccess.com'

function providerFrom(provider: object): TrustedHeaderProvider {
  const [parsed] = signInConfigSchema.parse({ providers: [provider] }).providers
  if (parsed?.kind !== 'trusted-header') throw new Error('not a trusted-header provider')
  return parsed
}

const bare = providerFrom({
  id: 'corp-proxy',
  kind: 'trusted-header',
  trustedAddresses: ['10.0.0.0/8', '::1'],
  identity: {
    subjectHeader: 'X-Forwarded-User',
    emailHeader: 'X-Forwarded-Email',
    nameHeader: 'X-Forwarded-Preferred-Username',
  },
})

const signed = providerFrom({
  id: 'access',
  kind: 'trusted-header',
  trustedAddresses: ['127.0.0.1'],
  assertion: {
    header: 'Cf-Access-Jwt-Assertion',
    issuer: ISSUER,
    audience: 'aud-1',
    jwksUri: `${ISSUER}/cdn-cgi/access/certs`,
  },
})

function request(peer: string | undefined, headers: Record<string, string>) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { peer, header: (name: string) => lower.get(name.toLowerCase()) }
}

describe('a bare identity header', () => {
  const read = createTrustedIdentityReader(bare)

  it('names the person when it comes from a trusted peer', async () => {
    const identity = await read(
      request('10.1.2.3', {
        'X-Forwarded-User': 'ada',
        'X-Forwarded-Email': 'ada@corp.example',
        'X-Forwarded-Preferred-Username': 'Ada',
      }),
    )
    expect(identity).toEqual({
      ok: true,
      claims: { sub: 'ada', email: 'ada@corp.example', email_verified: false, name: 'Ada' },
    })
  })

  // The header is only as trustworthy as the hop that set it: from anywhere
  // else, it is whatever the caller typed.
  it('is refused from a peer outside the trusted addresses', async () => {
    for (const peer of ['192.168.1.5', '11.0.0.1', '::2', undefined]) {
      const identity = await read(request(peer, { 'X-Forwarded-User': 'ada' }))
      expect(identity, String(peer)).toEqual({ ok: false, why: 'untrusted_peer' })
    }
  })

  it('matches a native IPv6 peer against an IPv6 entry', async () => {
    const identity = await read(request('::1', { 'X-Forwarded-User': 'ada' }))
    expect(identity.ok).toBe(true)
  })

  // A dual-stack socket reports an IPv4 client as `::ffff:a.b.c.d`.
  it('matches an IPv4 peer reported in its IPv6-mapped form', async () => {
    const identity = await read(request('::ffff:10.9.9.9', { 'X-Forwarded-User': 'ada' }))
    expect(identity.ok).toBe(true)
  })

  it('is refused when the subject header is absent or blank', async () => {
    for (const headers of [{}, { 'X-Forwarded-User': '   ' }]) {
      expect(await read(request('::1', headers))).toEqual({ ok: false, why: 'no_identity' })
    }
  })

  it('asserts a verified email only when the operator declared the proxy verifies it', async () => {
    const verifying = createTrustedIdentityReader(
      providerFrom({
        ...bare,
        identity: {
          subjectHeader: 'X-Forwarded-User',
          emailHeader: 'X-Forwarded-Email',
          emailVerified: true,
        },
      }),
    )
    const identity = await verifying(
      request('10.0.0.1', { 'X-Forwarded-User': 'ada', 'X-Forwarded-Email': 'ada@corp.example' }),
    )
    expect(identity.ok && identity.claims.email_verified).toBe(true)
  })
})

describe('a signed assertion', () => {
  let key: CryptoKey
  let read: ReturnType<typeof createTrustedIdentityReader>
  let otherKey: CryptoKey

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256')
    key = pair.privateKey
    otherKey = (await generateKeyPair('ES256')).privateKey
    const jwk = await exportJWK(pair.publicKey)
    read = createTrustedIdentityReader(signed, () => importJWK(jwk, 'ES256'))
  })

  interface TokenShape {
    signWith?: CryptoKey
    exp?: string
    iss?: string
    aud?: string
  }
  const token = (shape: TokenShape = {}) =>
    new SignJWT({ email: 'ada@corp.example' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(shape.iss ?? ISSUER)
      .setAudience(shape.aud ?? 'aud-1')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime(shape.exp ?? '5m')
      .sign(shape.signWith ?? key)

  it('names the person by the claims the proxy signed', async () => {
    const identity = await read(request('127.0.0.1', { 'Cf-Access-Jwt-Assertion': await token() }))
    expect(identity.ok && identity.claims.sub).toBe('user-1')
    expect(identity.ok && identity.claims.email).toBe('ada@corp.example')
  })

  it('is refused from an untrusted peer even when validly signed', async () => {
    const identity = await read(request('10.0.0.1', { 'Cf-Access-Jwt-Assertion': await token() }))
    expect(identity).toEqual({ ok: false, why: 'untrusted_peer' })
  })

  it('is refused when absent', async () => {
    expect(await read(request('127.0.0.1', {}))).toEqual({ ok: false, why: 'no_identity' })
  })

  it('is refused when signed by another key, for another audience, by another issuer, or expired', async () => {
    const bad = [
      await token({ signWith: otherKey }),
      await token({ aud: 'aud-2' }),
      await token({ iss: 'https://evil.example' }),
      await token({ exp: '-1m' }),
      'not.a.jwt',
    ]
    for (const assertion of bad) {
      const identity = await read(request('127.0.0.1', { 'Cf-Access-Jwt-Assertion': assertion }))
      expect(identity).toEqual({ ok: false, why: 'assertion_invalid' })
    }
  })

  // The proxy's key set decides which key; this list decides which
  // algorithms, so a key published for another one does not widen it.
  it('refuses an algorithm outside the pinned ones, even under a key the set holds', async () => {
    const pair = await generateKeyPair('ES384')
    const jwk = await exportJWK(pair.publicKey)
    const reader = createTrustedIdentityReader(signed, () => importJWK(jwk, 'ES384'))
    const es384 = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES384' })
      .setIssuer(ISSUER)
      .setAudience('aud-1')
      .setSubject('user-1')
      .setExpirationTime('5m')
      .sign(pair.privateKey)
    const identity = await reader(request('127.0.0.1', { 'Cf-Access-Jwt-Assertion': es384 }))
    expect(identity).toEqual({ ok: false, why: 'assertion_invalid' })
  })

  // `alg: none` carries no signature at all; accepting it would make the
  // assertion a bare header with extra steps.
  it('refuses an unsigned assertion', async () => {
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const unsigned = `${b64({ alg: 'none' })}.${b64({ iss: ISSUER, aud: 'aud-1', sub: 'x', exp: now + 60 })}.`
    const identity = await read(request('127.0.0.1', { 'Cf-Access-Jwt-Assertion': unsigned }))
    expect(identity).toEqual({ ok: false, why: 'assertion_invalid' })
  })
})
