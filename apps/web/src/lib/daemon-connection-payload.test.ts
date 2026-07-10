import { fc, test as fcTest } from '@fast-check/vitest'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  consumeDaemonConnectionFragment,
  daemonConnectionPayloadSchema,
  encodeDaemonConnectionFragment,
  parseDaemonConnectionFragment,
} from './daemon-connection-payload.js'

describe('daemonConnectionPayloadSchema', () => {
  it('accepts a minimal valid payload', () => {
    const result = daemonConnectionPayloadSchema.safeParse({
      baseUrl: 'http://127.0.0.1:3099',
      authMode: 'none',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a full payload with all optional fields', () => {
    const result = daemonConnectionPayloadSchema.safeParse({
      baseUrl: 'https://daemon.example.com',
      workspaceId: 'ws-1',
      slug: 'canvas-slug',
      bootstrapToken: 'a-long-enough-token',
      authMode: 'bootstrap',
      fullscreen: true,
    })
    expect(result.success).toBe(true)
  })

  it('rejects baseUrl with a path component', () => {
    const result = daemonConnectionPayloadSchema.safeParse({
      baseUrl: 'http://127.0.0.1:3099/foo',
      authMode: 'none',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-http(s) baseUrl scheme', () => {
    const result = daemonConnectionPayloadSchema.safeParse({
      baseUrl: 'ftp://127.0.0.1:3099',
      authMode: 'none',
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown authMode values', () => {
    const result = daemonConnectionPayloadSchema.safeParse({
      baseUrl: 'http://127.0.0.1:3099',
      authMode: 'oauth',
    })
    expect(result.success).toBe(false)
  })

  it('rejects too-short bootstrapToken', () => {
    const result = daemonConnectionPayloadSchema.safeParse({
      baseUrl: 'http://127.0.0.1:3099',
      authMode: 'bootstrap',
      bootstrapToken: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('accepts workspaceId without slug (workspace-level target)', () => {
    const result = daemonConnectionPayloadSchema.safeParse({
      baseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws-1',
      authMode: 'none',
    })
    expect(result.success).toBe(true)
  })

  it('rejects slug without workspaceId (a canvas is addressed by the pair)', () => {
    const result = daemonConnectionPayloadSchema.safeParse({
      baseUrl: 'http://127.0.0.1:3099',
      slug: 'my-canvas',
      authMode: 'none',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra unknown keys (strict)', () => {
    const result = daemonConnectionPayloadSchema.safeParse({
      baseUrl: 'http://127.0.0.1:3099',
      authMode: 'none',
      extra: 'nope',
    })
    expect(result.success).toBe(false)
  })

  it('rejects authMode "bootstrap" with no bootstrapToken', () => {
    const result = daemonConnectionPayloadSchema.safeParse({
      baseUrl: 'http://127.0.0.1:3099',
      authMode: 'bootstrap',
    })
    expect(result.success).toBe(false)
  })

  it('accepts authMode "none" with no bootstrapToken', () => {
    const result = daemonConnectionPayloadSchema.safeParse({
      baseUrl: 'http://127.0.0.1:3099',
      authMode: 'none',
    })
    expect(result.success).toBe(true)
  })
})

describe('parseDaemonConnectionFragment', () => {
  const payload = {
    baseUrl: 'http://127.0.0.1:3099',
    workspaceId: 'ws-1',
    slug: 'my-canvas',
    bootstrapToken: 'a-long-enough-token',
    authMode: 'bootstrap' as const,
    fullscreen: true,
  }

  it('round-trips a valid payload through encode/parse', () => {
    const hash = encodeDaemonConnectionFragment(payload)
    const result = parseDaemonConnectionFragment(hash)
    expect(result).toEqual({ status: 'ok', payload })
  })

  it('round-trips when the encoded fragment already has the leading #', () => {
    const hash = encodeDaemonConnectionFragment(payload)
    expect(hash.startsWith('#wb=')).toBe(true)
    const result = parseDaemonConnectionFragment(hash)
    expect(result.status).toBe('ok')
  })

  it('reports not-present for an empty hash', () => {
    expect(parseDaemonConnectionFragment('')).toEqual({ status: 'not-present' })
  })

  it('reports not-present for a bare "#"', () => {
    expect(parseDaemonConnectionFragment('#')).toEqual({ status: 'not-present' })
  })

  it('reports not-present when the hash has unrelated content', () => {
    expect(parseDaemonConnectionFragment('#other=1')).toEqual({ status: 'not-present' })
  })

  it('reports malformed for invalid base64url content', () => {
    const result = parseDaemonConnectionFragment('#wb=not-valid-base64url!!!')
    expect(result.status).toBe('malformed')
  })

  it('reports malformed for base64url content that is not valid JSON', () => {
    const notJson = encodeRawBase64Url('this is not json')
    const result = parseDaemonConnectionFragment(`#wb=${notJson}`)
    expect(result.status).toBe('malformed')
  })

  it('reports invalid for JSON that fails schema validation', () => {
    const badPayload = encodeRawBase64Url(JSON.stringify({ authMode: 'none' }))
    const result = parseDaemonConnectionFragment(`#wb=${badPayload}`)
    expect(result.status).toBe('invalid')
  })

  it('reports invalid when the payload has unknown extra keys', () => {
    const badPayload = encodeRawBase64Url(
      JSON.stringify({ baseUrl: 'http://127.0.0.1:3099', authMode: 'none', extra: 'x' }),
    )
    const result = parseDaemonConnectionFragment(`#wb=${badPayload}`)
    expect(result.status).toBe('invalid')
  })

  it('reports not-present for a percent-encoded "wb" key, matching removal behavior', () => {
    // URLSearchParams would decode '%77%62' to 'wb' and match it, but
    // consumeDaemonConnectionFragment's raw-string removal would not strip it —
    // parsing must use the same raw-key comparison so an unrecognized encoding
    // is never silently accepted and left lingering in the hash.
    const encoded = encodeRawBase64Url(JSON.stringify(payload))
    expect(parseDaemonConnectionFragment(`#%77%62=${encoded}`)).toEqual({ status: 'not-present' })
  })

  it('does not throw on arbitrary garbage input', () => {
    expect(() => parseDaemonConnectionFragment('#wb=%%%')).not.toThrow()
    expect(() => parseDaemonConnectionFragment('garbage')).not.toThrow()
  })

  fcTest.prop([fc.jsonValue()])('never throws for any base64url-wrapped JSON value', (json) => {
    const encoded = encodeRawBase64Url(JSON.stringify(json))
    expect(() => parseDaemonConnectionFragment(`#wb=${encoded}`)).not.toThrow()
  })

  fcTest.prop([fc.string()])('never throws for arbitrary hash strings', (raw) => {
    expect(() => parseDaemonConnectionFragment(raw)).not.toThrow()
  })
})

describe('consumeDaemonConnectionFragment', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/some/path?query=1')
  })

  it('removes the #wb= fragment from the URL without a page reload', () => {
    window.history.replaceState(null, '', `/some/path?query=1#wb=${encodeRawBase64Url('{}')}`)
    expect(window.location.hash).not.toBe('')

    consumeDaemonConnectionFragment()

    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/some/path')
    expect(window.location.search).toBe('?query=1')
  })

  it('is a no-op when there is no fragment', () => {
    window.history.replaceState(null, '', '/some/path?query=1')
    consumeDaemonConnectionFragment()
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/some/path')
  })

  it('preserves an unrelated fragment segment sharing the hash with wb', () => {
    window.history.replaceState(
      null,
      '',
      `/some/path?query=1#fullscreen&wb=${encodeRawBase64Url('{}')}`,
    )

    consumeDaemonConnectionFragment()

    expect(window.location.hash).toBe('#fullscreen')
    expect(window.location.pathname).toBe('/some/path')
    expect(window.location.search).toBe('?query=1')
  })
})

// Test-only helper that skips schema validation, for exercising malformed-payload paths.
function encodeRawBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
