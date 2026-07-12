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
    // WHATWG URL parsing treats '*' as an ordinary hostname character, so
    // `new URL('https://*.pages.dev/callback')` succeeds and `z.string().url()`
    // admits it. The explicit wildcard refinement is the only thing rejecting
    // this — it is load-bearing, not redundant.
    expect(result.success).toBe(false)
  })
})

describe('oauthClientRegistryEntrySchema redirect_uri constraints', () => {
  function parseUri(uri: string) {
    return oauthClientRegistrySchema.safeParse([{ clientId: 'x', redirectUris: [uri] }])
  }

  it('rejects a redirect_uri carrying a fragment — RFC 6749 §3.1.2', () => {
    expect(parseUri('https://whiteboard.pages.dev/oauth/callback#wb=token').success).toBe(false)
    expect(parseUri('https://whiteboard.pages.dev/oauth/callback#').success).toBe(false)
  })

  it('rejects a non-loopback http redirect_uri', () => {
    expect(parseUri('http://whiteboard.pages.dev/oauth/callback').success).toBe(false)
  })

  it('rejects a non-http(s) scheme', () => {
    expect(parseUri('javascript:alert(1)').success).toBe(false)
    expect(parseUri('whiteboard://callback').success).toBe(false)
  })

  it('admits https and the loopback http carve-out', () => {
    expect(parseUri('https://whiteboard.pages.dev/oauth/callback').success).toBe(true)
    expect(parseUri('http://127.0.0.1:5173/oauth/callback').success).toBe(true)
    expect(parseUri('http://localhost:5173/oauth/callback').success).toBe(true)
    expect(parseUri('http://[::1]:5173/oauth/callback').success).toBe(true)
  })

  it('does not let a loopback-lookalike host through the carve-out', () => {
    expect(parseUri('http://localhost.evil.com/oauth/callback').success).toBe(false)
    expect(parseUri('http://127.0.0.1.evil.com/oauth/callback').success).toBe(false)
  })

  it('still rejects a wildcard entry', () => {
    expect(parseUri('https://*.pages.dev/callback').success).toBe(false)
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
