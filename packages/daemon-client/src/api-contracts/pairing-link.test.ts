/**
 * Roundtrip + validation tests for the daemon-pairing-link api-contract
 * schema and its base64url fragment codec.
 *
 * The property below is the single guarantee that lets the MCP tool (Node)
 * and the browser parser (apps/web) share one fragment format instead of
 * each hand-rolling their own encoder: decode(encode(x)) === x for every
 * schema-valid payload, non-ASCII strings included.
 */
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import {
  DAEMON_CONNECTION_FRAGMENT_KEY,
  daemonConnectionPayloadSchema,
  decodeBase64UrlText,
  encodeBase64UrlText,
  isBareHttpOrigin,
  MIN_BOOTSTRAP_TOKEN_LENGTH,
} from './pairing-link.js'

describe('isBareHttpOrigin', () => {
  it('accepts a plain http(s) origin, with or without a port', () => {
    expect(isBareHttpOrigin('http://127.0.0.1:54231')).toBe(true)
    expect(isBareHttpOrigin('https://example.com')).toBe(true)
  })

  it('rejects an origin carrying credentials', () => {
    // new URL('https://user:pass@host').origin drops the credentials, so
    // the round-trip equality check (url.origin === value) is what actually
    // rejects this — pinned directly so a future rewrite of the predicate
    // (e.g. checking url.username/url.password instead) cannot silently
    // start accepting it.
    expect(isBareHttpOrigin('https://user:pass@example.com')).toBe(false)
  })

  it('rejects a wildcard host', () => {
    // WHITEBOARD_ALLOWED_WEB_ORIGINS may admit a `https://*.example.com`
    // pattern, but a pairing link targets one concrete origin — the
    // hostname.includes('*') check is what rejects it here.
    expect(isBareHttpOrigin('https://*.example.com')).toBe(false)
  })
})

describe('daemonConnectionPayloadSchema', () => {
  const valid = {
    baseUrl: 'http://127.0.0.1:54231',
    workspaceId: 'ws1',
    path: 'canvas-a',
    fullscreen: true,
    authMode: 'bootstrap' as const,
    bootstrapToken: 'x'.repeat(24),
  }

  it('accepts a well-formed bootstrap payload', () => {
    expect(daemonConnectionPayloadSchema.safeParse(valid).success).toBe(true)
  })

  it('accepts authMode "none" with no bootstrapToken', () => {
    expect(
      daemonConnectionPayloadSchema.safeParse({ baseUrl: valid.baseUrl, authMode: 'none' }).success,
    ).toBe(true)
  })

  it('rejects authMode "bootstrap" without a bootstrapToken', () => {
    const { bootstrapToken: _omit, ...missing } = valid
    expect(daemonConnectionPayloadSchema.safeParse(missing).success).toBe(false)
  })

  it('rejects a path without workspaceId', () => {
    const { workspaceId: _omit, ...withoutWorkspace } = valid
    expect(daemonConnectionPayloadSchema.safeParse(withoutWorkspace).success).toBe(false)
  })

  it('rejects a bootstrapToken shorter than MIN_BOOTSTRAP_TOKEN_LENGTH', () => {
    expect(
      daemonConnectionPayloadSchema.safeParse({
        ...valid,
        bootstrapToken: 'x'.repeat(MIN_BOOTSTRAP_TOKEN_LENGTH - 1),
      }).success,
    ).toBe(false)
  })

  it('rejects a non-bare-origin baseUrl', () => {
    expect(
      daemonConnectionPayloadSchema.safeParse({
        ...valid,
        baseUrl: 'http://127.0.0.1:54231/some/path',
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown top-level key (strict)', () => {
    expect(daemonConnectionPayloadSchema.safeParse({ ...valid, extra: 'nope' }).success).toBe(false)
  })

  it('the fragment key is "wb"', () => {
    expect(DAEMON_CONNECTION_FRAGMENT_KEY).toBe('wb')
  })
})

describe('base64url text codec', () => {
  it('round-trips a plain ASCII string', () => {
    expect(decodeBase64UrlText(encodeBase64UrlText('hello world'))).toBe('hello world')
  })

  it('round-trips a non-ASCII string', () => {
    const text = '日本語のワークスペース 🎨'
    expect(decodeBase64UrlText(encodeBase64UrlText(text))).toBe(text)
  })

  it('produces unpadded output using the URL-safe alphabet', () => {
    const encoded = encodeBase64UrlText('a')
    expect(encoded).not.toMatch(/[+/=]/)
  })

  fcTest.prop(
    [
      fc
        .record({
          baseUrl: fc.constantFrom('http://127.0.0.1:54231', 'https://example.pages.dev'),
          workspaceId: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
          bootstrapToken: fc.option(
            fc.string({ minLength: MIN_BOOTSTRAP_TOKEN_LENGTH, maxLength: 40 }),
            { nil: undefined },
          ),
          fullscreen: fc.option(fc.boolean(), { nil: undefined }),
          // Non-ASCII generator: exercises the encoder's UTF-8 path, which the
          // hand-rolled charCode loop in a naive implementation gets wrong.
          note: fc.string({ minLength: 0, maxLength: 12, unit: 'grapheme-composite' }),
        })
        .map(({ baseUrl, workspaceId, bootstrapToken, fullscreen, note }) => {
          const authMode = bootstrapToken !== undefined ? ('bootstrap' as const) : ('none' as const)
          const path = workspaceId !== undefined && note.length > 0 ? note : undefined
          return { baseUrl, workspaceId, path, bootstrapToken, fullscreen, authMode }
        }),
    ],
    withDefaults(),
  )('sharedDecode(sharedEncode(x)) deep-equals x for every schema-valid payload', (candidate) => {
    const parsed = daemonConnectionPayloadSchema.safeParse(candidate)
    if (!parsed.success) return // arbitrary occasionally produces a refine-rejected shape; skip it
    const json = JSON.stringify(parsed.data)
    const roundTripped = JSON.parse(decodeBase64UrlText(encodeBase64UrlText(json)))
    expect(roundTripped).toEqual(parsed.data)
  })
})
