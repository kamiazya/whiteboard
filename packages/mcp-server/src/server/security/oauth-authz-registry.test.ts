import { describe, expect, it } from 'vitest'
import {
  isRegisteredRedirectUri,
  type OAuthClientRegistry,
  oauthClientRegistrySchema,
  parseOAuthClientRegistryEnv,
} from './oauth-authz-registry.js'

const registry: OAuthClientRegistry = [
  {
    clientId: 'whiteboard-hosted-web',
    redirectUris: ['https://whiteboard.pages.dev/oauth/callback'],
  },
]

describe('isRegisteredRedirectUri', () => {
  it('admits an exact byte-for-byte match', () => {
    expect(
      isRegisteredRedirectUri(
        registry,
        'whiteboard-hosted-web',
        'https://whiteboard.pages.dev/oauth/callback',
      ),
    ).toBe(true)
  })

  it('rejects a suffix/prefix match — this is the trap ADR-0005 names explicitly', () => {
    // A substring match would let an attacker register
    // https://whiteboard.pages.dev/oauth/callback/evil and still pass.
    expect(
      isRegisteredRedirectUri(
        registry,
        'whiteboard-hosted-web',
        'https://whiteboard.pages.dev/oauth/callback/evil',
      ),
    ).toBe(false)
  })

  it('rejects a truncated prefix match', () => {
    expect(
      isRegisteredRedirectUri(
        registry,
        'whiteboard-hosted-web',
        'https://whiteboard.pages.dev/oauth/callbac',
      ),
    ).toBe(false)
  })

  it('rejects a same-origin different-path redirect_uri', () => {
    expect(
      isRegisteredRedirectUri(registry, 'whiteboard-hosted-web', 'https://whiteboard.pages.dev/'),
    ).toBe(false)
  })

  it('rejects an unknown client_id even with a registered redirect_uri string', () => {
    expect(
      isRegisteredRedirectUri(
        registry,
        'some-other-client',
        'https://whiteboard.pages.dev/oauth/callback',
      ),
    ).toBe(false)
  })

  it('never falls back to origin-only matching — a wildcard-origin-style entry is not accepted by the schema', () => {
    const result = oauthClientRegistrySchema.safeParse([
      { clientId: 'x', redirectUris: ['https://*.pages.dev/callback'] },
    ])
    // '*.pages.dev' is not a valid URL host, so schema parsing (z.string().url())
    // already rejects it before it could ever be used as a wildcard.
    expect(result.success).toBe(false)
  })
})

describe('parseOAuthClientRegistryEnv', () => {
  it('returns an empty registry for unset/empty input (feature off by default)', () => {
    expect(parseOAuthClientRegistryEnv(undefined)).toEqual({ ok: true, registry: [] })
    expect(parseOAuthClientRegistryEnv('  ')).toEqual({ ok: true, registry: [] })
  })

  it('parses a valid JSON registry', () => {
    const result = parseOAuthClientRegistryEnv(JSON.stringify(registry))
    expect(result).toEqual({ ok: true, registry })
  })

  it('fails on malformed JSON', () => {
    const result = parseOAuthClientRegistryEnv('{not json')
    expect(result.ok).toBe(false)
  })

  it('fails schema validation when an entry has no redirectUris', () => {
    const result = parseOAuthClientRegistryEnv(
      JSON.stringify([{ clientId: 'x', redirectUris: [] }]),
    )
    expect(result.ok).toBe(false)
  })
})
