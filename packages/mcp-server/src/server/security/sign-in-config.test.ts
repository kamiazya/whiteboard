/**
 * ADR-0046 decision 3: providers and their admission rules are declared in
 * configuration, validated by one schema. What the schema refuses is what an
 * operator would otherwise find out about at the first sign-in.
 */
import { describe, expect, it } from 'vitest'
import { providerAuthenticator, signInConfigSchema } from './sign-in-config.js'

const google = {
  id: 'google',
  kind: 'oidc',
  issuer: 'https://accounts.google.com',
  clientId: 'client-1',
  clientSecret: { env: 'WHITEBOARD_GOOGLE_CLIENT_SECRET' },
}

describe('signInConfigSchema', () => {
  it('defaults every provider to invitation-only, email invitations off', () => {
    const config = signInConfigSchema.parse({ providers: [google] })
    expect(config.providers[0]?.admission).toEqual({
      createAccounts: false,
      honourEmailInvitations: false,
    })
  })

  it('accepts several named providers, each with its own rules', () => {
    const config = signInConfigSchema.parse({
      providers: [
        { ...google, admission: { googleHostedDomains: ['corp.example'], createAccounts: true } },
        {
          id: 'keycloak',
          kind: 'oidc',
          issuer: 'https://sso.corp.example/realms/main',
          clientId: 'whiteboard',
          clientSecret: { file: '/run/secrets/keycloak' },
          admission: { requiredClaims: { groups: ['whiteboard'] } },
        },
      ],
    })
    expect(config.providers.map((p) => p.id)).toEqual(['google', 'keycloak'])
  })

  it.for([
    ['a plain-http issuer', { ...google, issuer: 'http://accounts.google.com' }],
    ['an inline client secret', { ...google, clientSecret: 'hunter2' }],
    ['an id with spaces or capitals', { ...google, id: 'Google Corp' }],
    ['an unknown admission key', { ...google, admission: { allowdEmailDomains: ['x.example'] } }],
    ['a domain with an @', { ...google, admission: { allowedEmailDomains: ['@corp.example'] } }],
    [
      'a required claim with no allowed value',
      { ...google, admission: { requiredClaims: { g: [] } } },
    ],
  ] as const)('refuses %s', ([, provider]) => {
    expect(signInConfigSchema.safeParse({ providers: [provider] }).success).toBe(false)
  })

  it('refuses two providers with the same id — the id is what a sign-in names', () => {
    const twin = { ...google, issuer: 'https://sso.corp.example' }
    expect(signInConfigSchema.safeParse({ providers: [google, twin] }).success).toBe(false)
  })

  // Two providers on one issuer would resolve the same subjects to the same
  // accounts under two different rule sets, and the looser one would win.
  it('refuses two providers with the same issuer', () => {
    const twin = { ...google, id: 'google-2' }
    expect(signInConfigSchema.safeParse({ providers: [google, twin] }).success).toBe(false)
  })
})

// A provider only there to admit bearers: no browser sign-in, so no client.
describe('a bearer-only provider', () => {
  const bearerOnly = {
    id: 'corp-mcp',
    kind: 'oidc',
    issuer: 'https://sso.corp.example',
    admission: { createAccounts: true, bearerClients: ['claude-code'] },
  }

  it('is accepted without a client', () => {
    const [provider] = signInConfigSchema.parse({ providers: [bearerOnly] }).providers
    expect(provider?.clientId).toBeUndefined()
  })

  // With no client and no bearer clients it could admit nobody, which is a
  // mistake to name at startup rather than a provider that silently does nothing.
  it('is refused when it names no bearer client', () => {
    const result = signInConfigSchema.safeParse({
      providers: [{ ...bearerOnly, admission: { createAccounts: true } }],
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('bearerClients')
  })

  it.for([
    ['a client id without its secret', { clientId: 'wb' }],
    ['a secret without its client id', { clientSecret: { env: 'SECRET' } }],
  ] as const)('refuses %s', ([, half]) => {
    expect(signInConfigSchema.safeParse({ providers: [{ ...bearerOnly, ...half }] }).success).toBe(
      false,
    )
  })
})

describe('providerAuthenticator', () => {
  // OIDC Core 1.0 section 2: `sub` is unique only within its issuer. Keying on
  // the operator's id instead would let an id re-pointed at another provider
  // resolve that provider's subjects to the old provider's accounts.
  it('names the authenticator by the issuer, never by the operator-chosen id', () => {
    const [provider] = signInConfigSchema.parse({ providers: [google] }).providers
    const key = provider && providerAuthenticator(provider)
    expect(key).toBe(providerAuthenticator({ issuer: 'https://accounts.google.com' }))
    expect(key).not.toBe(providerAuthenticator({ issuer: 'https://accounts.google.com/' }))
  })

  // It travels through auth decisions a handler may log; the provider's URL
  // stays out of it.
  it('does not spell the issuer', () => {
    const key = providerAuthenticator({ issuer: 'https://accounts.google.com' })
    expect(key.startsWith('oidc:')).toBe(true)
    expect(key).not.toContain('google')
  })
})

// ADR-0046 decision 2: a reverse proxy that has already signed the person in.
describe('a trusted-header provider', () => {
  const proxy = {
    id: 'corp-proxy',
    kind: 'trusted-header',
    trustedAddresses: ['10.0.0.0/8', '::1'],
    identity: { subjectHeader: 'X-Forwarded-User' },
  }
  const signed = {
    id: 'access',
    kind: 'trusted-header',
    trustedAddresses: ['127.0.0.1'],
    assertion: {
      header: 'Cf-Access-Jwt-Assertion',
      issuer: 'https://team.cloudflareaccess.com',
      audience: 'aud-1',
      jwksUri: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
    },
  }
  const parse = (provider: object) => signInConfigSchema.safeParse({ providers: [provider] })

  it('is accepted with a bare identity header, its email unverified unless declared', () => {
    const parsed = signInConfigSchema.parse({ providers: [proxy] }).providers[0]
    expect(parsed?.kind === 'trusted-header' && parsed.identity?.emailVerified).toBe(false)
  })

  it('is accepted with a signed assertion', () => {
    expect(parse(signed).success).toBe(true)
  })

  it('names exactly one of a signed assertion and an identity header', () => {
    expect(parse({ ...proxy, assertion: signed.assertion }).success).toBe(false)
    const { identity: _identity, ...neither } = proxy
    expect(parse(neither).success).toBe(false)
  })

  // An empty list would trust nobody and read like it trusts everybody.
  it('declares at least one trusted address, each an address or a range', () => {
    expect(parse({ ...proxy, trustedAddresses: [] }).success).toBe(false)
    for (const bad of [
      'proxy.internal',
      '10.0.0.0/33',
      '::1/129',
      '10.0.0.0/',
      '0.0.0.0/0',
      '::/0',
    ]) {
      expect(parse({ ...proxy, trustedAddresses: [bad] }).success, bad).toBe(false)
    }
  })

  // A zone id names an interface, not an address anyone can match.
  it('refuses a zone-scoped address', () => {
    expect(parse({ ...proxy, trustedAddresses: ['fe80::1%eth0'] }).success).toBe(false)
  })

  // Reading the person's name from a header the proxy passes through
  // untouched would believe the caller, not the proxy.
  it('refuses a credential or forwarding header as the identity', () => {
    for (const subjectHeader of [
      'Authorization',
      'cookie',
      'X-Forwarded-For',
      'Host',
      'Forwarded',
    ]) {
      expect(parse({ ...proxy, identity: { subjectHeader } }).success, subjectHeader).toBe(false)
    }
  })

  // Two providers resolving the same subject to one account would let the
  // looser one's rules admit the person the stricter one refused.
  it('refuses two assertion providers with the same issuer', () => {
    const twin = {
      ...signed,
      id: 'access-2',
      assertion: { ...signed.assertion, audience: 'aud-2' },
    }
    expect(signInConfigSchema.safeParse({ providers: [signed, twin] }).success).toBe(false)
  })

  it('verifies a signed assertion over https only', () => {
    const plain = { ...signed.assertion, jwksUri: 'http://team.example/certs' }
    expect(parse({ ...signed, assertion: plain }).success).toBe(false)
  })

  // A proxy's header is read in a browser sign-in; no bearer carries it.
  it('is refused when it names bearer clients', () => {
    expect(parse({ ...proxy, admission: { bearerClients: ['cli'] } }).success).toBe(false)
  })

  it('shares no authenticator with an OIDC provider, or with another proxy', () => {
    const [bare, assertion] = signInConfigSchema.parse({ providers: [proxy, signed] }).providers
    const keys = [bare, assertion].map((p) => p && providerAuthenticator(p))
    expect(keys[0]?.startsWith('proxy:')).toBe(true)
    expect(
      new Set([...keys, providerAuthenticator({ issuer: signed.assertion.issuer })]).size,
    ).toBe(3)
  })
})
