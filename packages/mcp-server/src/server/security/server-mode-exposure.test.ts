import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import {
  type ServerModeExposureDecision,
  isOriginAllowedForServerMode,
  resolveServerModeExposure,
} from './server-mode-exposure.js'

// ── local-daemon: loopback-only policy ──────────────────────────────────────

describe('resolveServerModeExposure — local-daemon loopback policy', () => {
  it.each(['127.0.0.1', 'localhost', '::1', '[::1]'])(
    'loopback bind %j → ok, kind local-loopback',
    (bindHost) => {
      const d = resolveServerModeExposure({ mode: 'local-daemon', bindHost })
      expect(d.ok).toBe(true)
      if (d.ok) expect(d.kind).toBe('local-loopback')
    },
  )

  it.each(['0.0.0.0', '10.0.0.1', '192.168.1.100', 'example.com'])(
    'non-loopback bind %j → local_daemon.non_loopback_forbidden',
    (bindHost) => {
      const d = resolveServerModeExposure({ mode: 'local-daemon', bindHost })
      expect(d.ok).toBe(false)
      if (!d.ok) expect(d.code).toBe('local_daemon.non_loopback_forbidden')
    },
  )

  it('non-loopback + externalUrl https → still local_daemon.non_loopback_forbidden (externalUrl does not unlock non-loopback)', () => {
    const d = resolveServerModeExposure({
      mode: 'local-daemon',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com',
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('local_daemon.non_loopback_forbidden')
  })

  it('success carries trustedProxy: false — local daemon never trusts proxy headers', () => {
    const d = resolveServerModeExposure({ mode: 'local-daemon', bindHost: '127.0.0.1' })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.trustedProxy).toBe(false)
  })

  it('success allowedOrigins contains only loopback http origins', () => {
    const d = resolveServerModeExposure({ mode: 'local-daemon', bindHost: '127.0.0.1' })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    // Every origin in the allowlist must be loopback and http — no https,
    // no non-loopback, no wildcards.
    for (const origin of d.allowedOrigins) {
      expect(origin).toMatch(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])$/)
    }
  })

  it('publicBaseUrl is an http loopback origin', () => {
    const d = resolveServerModeExposure({ mode: 'local-daemon', bindHost: '127.0.0.1' })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.publicBaseUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/)
  })

  it('bindHost ::1 (unbracketed IPv6) → publicBaseUrl http://[::1] (valid IPv6 URL)', () => {
    const d = resolveServerModeExposure({ mode: 'local-daemon', bindHost: '::1' })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.publicBaseUrl).toBe('http://[::1]')
  })
})

// ── server-mode: external URL contract ──────────────────────────────────────

describe('resolveServerModeExposure — server-mode externalUrl validation', () => {
  it('missing externalUrl → server_mode.external_url_required', () => {
    const d = resolveServerModeExposure({ mode: 'server-mode', bindHost: '0.0.0.0' })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.external_url_required')
  })

  it.each(['http://example.com', 'http://example.com/path', 'ftp://example.com', 'not-a-url'])(
    'non-https externalUrl %j → server_mode.external_url_must_be_https',
    (externalUrl) => {
      const d = resolveServerModeExposure({ mode: 'server-mode', bindHost: '0.0.0.0', externalUrl })
      expect(d.ok).toBe(false)
      if (!d.ok) expect(d.code).toBe('server_mode.external_url_must_be_https')
    },
  )

  it.each([
    'https://user:pass@example.com',
    'https://user@example.com',
    'https://example.com/path',
    'https://example.com/path/sub',
    'https://example.com?token=secret',
    'https://example.com?q=1',
    'https://example.com#fragment',
    'https://example.com/path?q=1#frag',
  ])(
    'non-origin externalUrl %j → server_mode.external_url_must_be_origin',
    (externalUrl) => {
      const d = resolveServerModeExposure({ mode: 'server-mode', bindHost: '0.0.0.0', externalUrl })
      expect(d.ok).toBe(false)
      if (!d.ok) expect(d.code).toBe('server_mode.external_url_must_be_origin')
    },
  )

  it('wildcard * in allowedOrigins → server_mode.wildcard_origin_forbidden', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com',
      allowedOrigins: ['*'],
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.wildcard_origin_forbidden')
  })

  it('allowedOrigins with http:// entry → server_mode.external_url_must_be_origin', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com',
      allowedOrigins: ['http://app.example.com'],
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.external_url_must_be_origin')
  })

  it.each([
    'https://app.example.com/path',
    'https://app.example.com/path/sub',
    'https://user:pass@app.example.com',
    'https://user@app.example.com',
    'https://app.example.com?token=secret',
    'https://app.example.com#frag',
  ])(
    'non-origin allowedOrigin %j → server_mode.external_url_must_be_origin',
    (badOrigin) => {
      const d = resolveServerModeExposure({
        mode: 'server-mode',
        bindHost: '0.0.0.0',
        externalUrl: 'https://example.com',
        allowedOrigins: [badOrigin],
      })
      expect(d.ok).toBe(false)
      if (!d.ok) expect(d.code).toBe('server_mode.external_url_must_be_origin')
    },
  )

  it('valid https origin + https allowedOrigins → ok, kind server-mode', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com',
      allowedOrigins: ['https://app.example.com'],
    })
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.kind).toBe('server-mode')
      expect(d.publicBaseUrl).toBe('https://example.com')
      expect(d.allowedOrigins).toEqual(['https://app.example.com'])
    }
  })

  it('valid https origin without trailing slash → publicBaseUrl equals origin', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://api.example.com',
    })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.publicBaseUrl).toBe('https://api.example.com')
  })

  it('https origin with non-default port → preserved in publicBaseUrl', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com:8443',
    })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.publicBaseUrl).toBe('https://example.com:8443')
  })

  it('trustedProxy: true is reflected in success decision', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com',
      trustedProxy: true,
    })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.trustedProxy).toBe(true)
  })

  it('trustedProxy defaults to false when not provided', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com',
    })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.trustedProxy).toBe(false)
  })

  it('empty allowedOrigins is valid — no browser clients, still ok', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com',
      allowedOrigins: [],
    })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.allowedOrigins).toEqual([])
  })
})

// ── non-leak: failure decisions never carry sensitive URL pieces ──────────────

describe('resolveServerModeExposure — non-leak guard on failure decisions', () => {
  it('query-string rejection does not echo the query string in the failure code', () => {
    const CANARY = 'token=canary-secret-XYZ'
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: `https://example.com?${CANARY}`,
    })
    expect(d.ok).toBe(false)
    const serialized = JSON.stringify(d)
    expect(serialized).not.toContain('canary-secret-XYZ')
    expect(serialized).not.toContain(CANARY)
    expect(serialized).not.toContain('example.com')
  })

  it('credentials rejection does not echo username/password', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://admin:canary-pass@example.com',
    })
    expect(d.ok).toBe(false)
    const serialized = JSON.stringify(d)
    expect(serialized).not.toContain('canary-pass')
    expect(serialized).not.toContain('admin')
    expect(serialized).not.toContain('example.com')
  })

  it('allowedOrigins with query rejection does not echo query in failure', () => {
    const CANARY = 'canary-allowed-origin-secret-XYZ'
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com',
      allowedOrigins: [`https://app.example.com?${CANARY}`],
    })
    expect(d.ok).toBe(false)
    const serialized = JSON.stringify(d)
    expect(serialized).not.toContain(CANARY)
    expect(serialized).not.toContain('app.example.com')
  })

  it('allowedOrigins with credentials rejection does not echo credentials in failure', () => {
    const CANARY = 'canary-pass-XYZ'
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com',
      allowedOrigins: [`https://user:${CANARY}@app.example.com`],
    })
    expect(d.ok).toBe(false)
    const serialized = JSON.stringify(d)
    expect(serialized).not.toContain(CANARY)
  })

  it('http rejection does not echo the raw URL', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'http://internal.corp.example.com',
    })
    expect(d.ok).toBe(false)
    const serialized = JSON.stringify(d)
    expect(serialized).not.toContain('internal.corp.example.com')
  })
})

// ── per-request origin allowlist check ──────────────────────────────────────

describe('isOriginAllowedForServerMode', () => {
  it('listed https origin → allowed', () => {
    expect(isOriginAllowedForServerMode('https://app.example.com', ['https://app.example.com']))
      .toBe(true)
  })

  it('unlisted origin → not allowed', () => {
    expect(
      isOriginAllowedForServerMode('https://evil.example.com', ['https://app.example.com']),
    ).toBe(false)
  })

  it('empty allowedOrigins → not allowed', () => {
    expect(isOriginAllowedForServerMode('https://app.example.com', [])).toBe(false)
  })

  it('exact match required — subdomain mismatch is rejected', () => {
    expect(
      isOriginAllowedForServerMode(
        'https://sub.app.example.com',
        ['https://app.example.com'],
      ),
    ).toBe(false)
  })
})

// ── Deterministic anchors ────────────────────────────────────────────────────

describe('resolveServerModeExposure — deterministic contract anchors', () => {
  it('bindHost [::1] (already-bracketed IPv6) → publicBaseUrl http://[::1] without double-bracketing', () => {
    const d = resolveServerModeExposure({ mode: 'local-daemon', bindHost: '[::1]' })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.publicBaseUrl).toBe('http://[::1]')
  })

  it('externalUrl with empty username and non-empty password → external_url_must_be_origin', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://:secret@example.com',
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.external_url_must_be_origin')
  })

  it('allowedOrigin with empty username and non-empty password → external_url_must_be_origin', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com',
      allowedOrigins: ['https://:secret@app.example.com'],
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.external_url_must_be_origin')
  })

  it('allowedOrigin with completely unparseable string → external_url_must_be_origin', () => {
    const d = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com',
      allowedOrigins: ['not-a-url'],
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.external_url_must_be_origin')
  })
})

// ── PBT: URL parser edge-case properties ────────────────────────────────────

// Property 1: any https URL with a non-empty search/hash/credentials is
// rejected, and the failure decision does not echo the raw URL.
// We use a `CANARY_` prefix on generated values so short substrings cannot
// accidentally appear inside error code tokens (e.g. "a" in "external").
fcTest.prop(
  [
    fc.record({
      // fc.domain() produces hostnames that are valid but arbitrary —
      // wrapping in a canary prefix is not needed for host since we only
      // check the full URL, not the host alone.
      host: fc.domain(),
      suffix: fc.integer({ min: 10000000, max: 99999999 }).map((n) => n.toString()),
      // Choose exactly one dirty piece per run to keep shrinking useful.
      kind: fc.constantFrom('query', 'fragment', 'credentials' as const),
    }),
  ],
  withDefaults(),
)(
  'any https URL with credentials/query/fragment is rejected and failure does not echo those pieces',
  ({ host, suffix, kind }) => {
    // Canary strings are long enough that they cannot be substrings of any
    // failure code token.
    const canary = `CANARY_${suffix}`
    let url: string
    switch (kind) {
      case 'query':
        url = `https://${host}?token=${canary}`
        break
      case 'fragment':
        url = `https://${host}#${canary}`
        break
      case 'credentials':
        url = `https://${canary}:${canary}@${host}`
        break
    }

    const d: ServerModeExposureDecision = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: url,
    })
    expect(d.ok).toBe(false)
    const serialized = JSON.stringify(d)
    // The canary and the full URL must not appear in the failure decision.
    expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain(host)
  },
)

// Property 2: any accepted server-mode decision has an origin-only publicBaseUrl.
fcTest.prop(
  [
    fc.record({
      // Generate a simple hostname (domain), avoiding unusual URL edge cases
      host: fc.domain(),
    }),
  ],
  withDefaults(),
)(
  'accepted server-mode decision always has an https origin-only publicBaseUrl',
  ({ host }) => {
    const externalUrl = `https://${host}`
    const d: ServerModeExposureDecision = resolveServerModeExposure({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl,
    })
    if (!d.ok) return // some generated hostnames may produce invalid URLs — skip
    expect(d.publicBaseUrl).toMatch(/^https:\/\//)
    // publicBaseUrl must be origin-only: no path beyond /, no query, no hash
    const parsed = new URL(d.publicBaseUrl)
    expect(parsed.username).toBe('')
    expect(parsed.password).toBe('')
    expect(parsed.pathname).toBe('/')
    expect(parsed.search).toBe('')
    expect(parsed.hash).toBe('')
    // publicBaseUrl must equal the URL's own origin
    expect(d.publicBaseUrl).toBe(parsed.origin)
  },
)
