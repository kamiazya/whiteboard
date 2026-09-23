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

describe('providerAuthenticator', () => {
  // OIDC Core 1.0 section 2: `sub` is unique only within its issuer. Keying on
  // the operator's id instead would let an id re-pointed at another provider
  // resolve that provider's subjects to the old provider's accounts.
  it('names the authenticator by the issuer, never by the operator-chosen id', () => {
    const [provider] = signInConfigSchema.parse({ providers: [google] }).providers
    expect(provider && providerAuthenticator(provider)).toBe('oidc:https://accounts.google.com')
  })
})
