import { describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../log.js'
import {
  isAllowedWebOrigin,
  loadAllowedWebOriginsFromEnv,
  parseAllowedWebOriginsEnv,
} from './web-origin-allowlist.js'

describe('parseAllowedWebOriginsEnv', () => {
  it('returns an empty allowlist when unset', () => {
    expect(parseAllowedWebOriginsEnv(undefined)).toEqual({ ok: true, origins: [] })
  })

  it('returns an empty allowlist for an empty string', () => {
    expect(parseAllowedWebOriginsEnv('')).toEqual({ ok: true, origins: [] })
  })

  it('parses a single origin', () => {
    expect(parseAllowedWebOriginsEnv('https://kamiazya-whiteboard.pages.dev')).toEqual({
      ok: true,
      origins: ['https://kamiazya-whiteboard.pages.dev'],
    })
  })

  it('parses comma-separated origins, trimming whitespace', () => {
    expect(parseAllowedWebOriginsEnv(' https://a.example , https://b.example  ')).toEqual({
      ok: true,
      origins: ['https://a.example', 'https://b.example'],
    })
  })

  it('normalizes a trailing slash', () => {
    expect(parseAllowedWebOriginsEnv('https://a.example/')).toEqual({
      ok: true,
      origins: ['https://a.example'],
    })
  })

  it('fails with the entry index for a path suffix', () => {
    expect(parseAllowedWebOriginsEnv('https://a.example, https://b.example/app')).toEqual({
      ok: false,
      code: 'web_origins.entry_must_be_origin',
      entryIndex: 1,
    })
  })

  it('fails for a wildcard entry', () => {
    expect(parseAllowedWebOriginsEnv('*')).toEqual({
      ok: false,
      code: 'web_origins.wildcard_forbidden',
      entryIndex: 0,
    })
  })

  it('fails for an http:// entry', () => {
    expect(parseAllowedWebOriginsEnv('http://a.example')).toEqual({
      ok: false,
      code: 'web_origins.entry_must_be_https',
      entryIndex: 0,
    })
  })

  it('fails for an unparseable entry', () => {
    expect(parseAllowedWebOriginsEnv('not a url')).toEqual({
      ok: false,
      code: 'web_origins.entry_unparseable',
      entryIndex: 0,
    })
  })

  it('accepts a wildcard subdomain pattern alongside an exact origin', () => {
    expect(
      parseAllowedWebOriginsEnv('https://*.kamiazya-whiteboard.pages.dev, https://second.example'),
    ).toEqual({
      ok: true,
      origins: ['https://*.kamiazya-whiteboard.pages.dev', 'https://second.example'],
    })
  })

  it('fails with the entry index for an invalid wildcard pattern', () => {
    expect(parseAllowedWebOriginsEnv('https://a.example, https://foo*.b.example')).toEqual({
      ok: false,
      code: 'web_origins.invalid_wildcard_pattern',
      entryIndex: 1,
    })
  })

  it('fails for a suffix too short to admit a wildcard pattern', () => {
    expect(parseAllowedWebOriginsEnv('https://*.dev')).toEqual({
      ok: false,
      code: 'web_origins.invalid_wildcard_pattern',
      entryIndex: 0,
    })
  })
})

describe('isAllowedWebOrigin', () => {
  const allowlist = ['https://kamiazya-whiteboard.pages.dev', 'https://second.example']

  it('admits an exact match', () => {
    expect(isAllowedWebOrigin('https://kamiazya-whiteboard.pages.dev', allowlist)).toBe(true)
  })

  it('admits a match against a later allowlist entry', () => {
    expect(isAllowedWebOrigin('https://second.example', allowlist)).toBe(true)
  })

  it('rejects an evil-prefix lookalike host', () => {
    expect(isAllowedWebOrigin('https://evil-kamiazya-whiteboard.pages.dev', allowlist)).toBe(false)
  })

  it('rejects a suffix-match lookalike host', () => {
    expect(isAllowedWebOrigin('https://kamiazya-whiteboard.pages.dev.evil.com', allowlist)).toBe(
      false,
    )
  })

  it('rejects a scheme mismatch', () => {
    expect(isAllowedWebOrigin('http://kamiazya-whiteboard.pages.dev', allowlist)).toBe(false)
  })

  it('rejects a port mismatch', () => {
    expect(isAllowedWebOrigin('https://kamiazya-whiteboard.pages.dev:8443', allowlist)).toBe(false)
  })

  it('rejects when the allowlist is empty', () => {
    expect(isAllowedWebOrigin('https://kamiazya-whiteboard.pages.dev', [])).toBe(false)
  })

  it('normalizes case and default port on the request origin', () => {
    expect(isAllowedWebOrigin('https://Kamiazya-Whiteboard.pages.dev:443', allowlist)).toBe(true)
  })

  it('is false for an undefined origin header', () => {
    expect(isAllowedWebOrigin(undefined, allowlist)).toBe(false)
  })

  it('admits an origin matched by a wildcard pattern', () => {
    const wildcardAllowlist = ['https://*.kamiazya-whiteboard.pages.dev']
    expect(
      isAllowedWebOrigin('https://preview-42.kamiazya-whiteboard.pages.dev', wildcardAllowlist),
    ).toBe(true)
  })

  it('rejects an origin not matched by any wildcard pattern', () => {
    const wildcardAllowlist = ['https://*.kamiazya-whiteboard.pages.dev']
    expect(isAllowedWebOrigin('https://kamiazya-whiteboard.pages.dev', wildcardAllowlist)).toBe(
      false,
    )
    expect(isAllowedWebOrigin('https://evil.com', wildcardAllowlist)).toBe(false)
  })
})

describe('loadAllowedWebOriginsFromEnv', () => {
  it('returns an empty allowlist when unset', () => {
    expect(loadAllowedWebOriginsFromEnv({})).toEqual([])
  })

  it('returns the parsed allowlist on success', () => {
    expect(
      loadAllowedWebOriginsFromEnv({
        WHITEBOARD_ALLOWED_WEB_ORIGINS: 'https://kamiazya-whiteboard.pages.dev',
      }),
    ).toEqual(['https://kamiazya-whiteboard.pages.dev'])
  })

  it('returns null and logs an error record without echoing the raw value on failure', () => {
    const capture = captureLogsForTests('debug')
    try {
      const result = loadAllowedWebOriginsFromEnv({
        WHITEBOARD_ALLOWED_WEB_ORIGINS: 'not a url',
      })
      expect(result).toBeNull()
      const record = capture.records.find(
        (r) => r.scope === 'web-origin-allowlist' && r.level === 'error',
      )
      expect(record).toBeDefined()
      expect(record?.data?.code).toBe('web_origins.entry_unparseable')
      expect(record?.data?.entryIndex).toBe(0)
      expect(JSON.stringify(record)).not.toContain('not a url')
    } finally {
      capture.restore()
    }
  })
})
