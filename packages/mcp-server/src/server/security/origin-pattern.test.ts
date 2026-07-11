import { describe, expect, it } from 'vitest'
import {
  canonicalizeOriginPatternEntry,
  formatOriginPatternEntry,
  matchOrigin,
  parseOriginPatternEntry,
} from './origin-pattern.js'

describe('parseOriginPatternEntry', () => {
  it('accepts an exact https origin', () => {
    const result = parseOriginPatternEntry('https://app.example.com')
    expect(result).toEqual({
      ok: true,
      pattern: { kind: 'exact', origin: 'https://app.example.com' },
    })
  })

  it('accepts a leftmost-label wildcard pattern', () => {
    const result = parseOriginPatternEntry('https://*.kamiazya-whiteboard.pages.dev')
    expect(result).toEqual({
      ok: true,
      pattern: {
        kind: 'wildcard-subdomain',
        suffixHost: 'kamiazya-whiteboard.pages.dev',
        port: '',
      },
    })
  })

  it('rejects bare wildcard', () => {
    expect(parseOriginPatternEntry('*')).toEqual({ ok: false, reason: 'wildcard' })
  })

  it('rejects mid-label wildcard', () => {
    expect(parseOriginPatternEntry('https://foo*.x.com')).toEqual({
      ok: false,
      reason: 'wildcard_not_leftmost',
    })
  })

  it('rejects multi-wildcard patterns', () => {
    expect(parseOriginPatternEntry('https://*.*.example.com')).toEqual({
      ok: false,
      reason: 'wildcard_multi_label',
    })
  })

  it('rejects suffixes with fewer than two static labels', () => {
    expect(parseOriginPatternEntry('https://*.dev')).toEqual({
      ok: false,
      reason: 'wildcard_suffix_too_short',
    })
    expect(parseOriginPatternEntry('https://*.com')).toEqual({
      ok: false,
      reason: 'wildcard_suffix_too_short',
    })
  })

  it('rejects non-https wildcard patterns', () => {
    expect(parseOriginPatternEntry('http://*.example.com')).toEqual({
      ok: false,
      reason: 'not_https',
    })
  })

  it('rejects wildcard patterns with a non-origin shape', () => {
    expect(parseOriginPatternEntry('https://*.example.com/path')).toEqual({
      ok: false,
      reason: 'not_origin',
    })
    expect(parseOriginPatternEntry('https://user:pass@*.example.com')).toEqual({
      ok: false,
      reason: 'not_origin',
    })
  })

  it('rejects an IP-literal suffix', () => {
    // WHATWG URL parsing throws on a wildcard host whose static suffix looks
    // like an IPv4 address before this module's own IP-suffix check ever
    // runs — the request never reaches a URL-parseable state, so the
    // reported reason is 'unparseable', not 'wildcard_ip_suffix'.
    const result = parseOriginPatternEntry('https://*.127.0.0.1')
    expect(result).toEqual({ ok: false, reason: 'unparseable' })
  })

  it('rejects a trailing dot on the pattern suffix', () => {
    const result = parseOriginPatternEntry('https://*.example.com.')
    expect(result.ok).toBe(false)
  })

  it('punycode-normalizes a Unicode-spelled wildcard pattern', () => {
    // WHATWG URL parsing punycode-encodes a Unicode host identically on the
    // pattern side and the request-Origin side, so a Unicode-spelled pattern
    // entry is accepted and normalized rather than rejected.
    const result = parseOriginPatternEntry('https://*.例え.example')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.pattern).toEqual({
      kind: 'wildcard-subdomain',
      suffixHost: 'xn--r8jz45g.example',
      port: '',
    })
  })

  it('accepts a punycode wildcard pattern with an explicit port', () => {
    const result = parseOriginPatternEntry('https://*.xn--wgv71a.example:8443')
    expect(result).toEqual({
      ok: true,
      pattern: { kind: 'wildcard-subdomain', suffixHost: 'xn--wgv71a.example', port: '8443' },
    })
  })
})

describe('formatOriginPatternEntry / canonicalizeOriginPatternEntry', () => {
  it('round-trips a wildcard pattern to its canonical string form', () => {
    const parsed = parseOriginPatternEntry('https://*.example.com:8443')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(formatOriginPatternEntry(parsed.pattern)).toBe('https://*.example.com:8443')
  })

  it('canonicalizes a portless wildcard pattern without a trailing colon', () => {
    expect(canonicalizeOriginPatternEntry('https://*.example.com')).toBe('https://*.example.com')
  })

  it('canonicalizes an exact origin unchanged', () => {
    expect(canonicalizeOriginPatternEntry('https://app.example.com')).toBe(
      'https://app.example.com',
    )
  })
})

describe('matchOrigin', () => {
  function wildcard(suffixHost: string, port = '') {
    const result = parseOriginPatternEntry(`https://*.${suffixHost}${port ? `:${port}` : ''}`)
    if (!result.ok) throw new Error('test setup: pattern must parse')
    return result.pattern
  }

  function exact(origin: string) {
    const result = parseOriginPatternEntry(origin)
    if (!result.ok) throw new Error('test setup: origin must parse')
    return result.pattern
  }

  it('matches a single-label subdomain against the wildcard suffix', () => {
    expect(matchOrigin([wildcard('example.com')], 'https://x.example.com')).toBe(true)
  })

  it('does not match a two-label subdomain', () => {
    expect(matchOrigin([wildcard('example.com')], 'https://a.b.example.com')).toBe(false)
  })

  it('does not match the bare suffix with zero labels', () => {
    expect(matchOrigin([wildcard('example.com')], 'https://example.com')).toBe(false)
  })

  it('matches case-insensitively', () => {
    expect(matchOrigin([wildcard('example.com')], 'HTTPS://X.EXAMPLE.COM')).toBe(true)
  })

  it('never matches a non-https request origin', () => {
    expect(matchOrigin([wildcard('example.com')], 'http://x.example.com')).toBe(false)
  })

  it('matches an explicit :443 request origin against a portless pattern', () => {
    expect(matchOrigin([wildcard('example.com')], 'https://x.example.com:443')).toBe(true)
  })

  it('matches an explicit :443 pattern against a portless request origin', () => {
    expect(matchOrigin([wildcard('example.com', '443')], 'https://x.example.com')).toBe(true)
  })

  it('does not match a mismatched explicit port', () => {
    expect(matchOrigin([wildcard('example.com', '8443')], 'https://x.example.com:9000')).toBe(false)
    expect(matchOrigin([wildcard('example.com')], 'https://x.example.com:9000')).toBe(false)
  })

  it('still admits exact-match patterns alongside wildcard patterns', () => {
    const patterns = [wildcard('example.com'), exact('https://other.example')]
    expect(matchOrigin(patterns, 'https://other.example')).toBe(true)
    expect(matchOrigin(patterns, 'https://x.example.com')).toBe(true)
    expect(matchOrigin(patterns, 'https://not-matched.example')).toBe(false)
  })

  it('rejects non-matching origins', () => {
    expect(matchOrigin([wildcard('example.com')], 'https://evil.com')).toBe(false)
  })

  it('never matches IPv6, IPv4, or localhost request origins', () => {
    const patterns = [wildcard('example.com')]
    expect(matchOrigin(patterns, 'https://[::1]:8443')).toBe(false)
    expect(matchOrigin(patterns, 'https://127.0.0.1')).toBe(false)
    expect(matchOrigin(patterns, 'https://192.168.1.10')).toBe(false)
    expect(matchOrigin(patterns, 'https://localhost')).toBe(false)
  })

  it('does not match a trailing-dot request origin', () => {
    expect(matchOrigin([wildcard('example.com')], 'https://x.example.com.')).toBe(false)
  })

  it('matches a punycode suffix against a Unicode request Origin header', () => {
    // WHATWG URL parsing normalizes a Unicode host to punycode identically on
    // both sides, so a Unicode Origin header can match a punycode pattern
    // suffix even though patterns themselves are typically written in punycode.
    expect(matchOrigin([wildcard('xn--r8jz45g.example')], 'https://x.例え.example')).toBe(true)
  })

  it('returns false for an empty pattern list or missing origin header', () => {
    expect(matchOrigin([], 'https://x.example.com')).toBe(false)
    expect(matchOrigin([wildcard('example.com')], undefined)).toBe(false)
  })
})
