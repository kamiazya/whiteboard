import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { matchOrigin, parseOriginPatterns } from './origin-pattern.js'
import {
  resolveServerModeExposure,
  type ServerModeExposureDecision,
} from './server-mode-exposure.js'

// The per-request check as server-mode-middleware composes it: the resolved
// entries parsed into patterns, then matched against the request's origin.
const isAllowed = (requestOrigin: string, allowedOrigins: readonly string[]): boolean =>
  matchOrigin(parseOriginPatterns(allowedOrigins), requestOrigin)

// ── server-mode: external URL contract ──────────────────────────────────────

describe('resolveServerModeExposure — server-mode externalUrl validation', () => {
  it('missing externalUrl → server_mode.external_url_required', () => {
    const d = resolveServerModeExposure({})
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.external_url_required')
  })

  it.each([
    'http://example.com',
    'http://example.com/path',
    'ftp://example.com',
    'not-a-url',
  ])('non-https externalUrl %j → server_mode.external_url_must_be_https', (externalUrl) => {
    const d = resolveServerModeExposure({ externalUrl })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.external_url_must_be_https')
  })

  it.each([
    'https://user:pass@example.com',
    'https://user@example.com',
    'https://example.com/path',
    'https://example.com/path/sub',
    'https://example.com?token=secret',
    'https://example.com?q=1',
    'https://example.com#fragment',
    'https://example.com/path?q=1#frag',
  ])('non-origin externalUrl %j → server_mode.external_url_must_be_origin', (externalUrl) => {
    const d = resolveServerModeExposure({ externalUrl })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.external_url_must_be_origin')
  })

  it('wildcard * in allowedOrigins → server_mode.wildcard_origin_forbidden', () => {
    const d = resolveServerModeExposure({
      externalUrl: 'https://example.com',
      allowedOrigins: ['*'],
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.wildcard_origin_forbidden')
  })

  it('allowedOrigins with http:// entry → server_mode.external_url_must_be_origin', () => {
    const d = resolveServerModeExposure({
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
  ])('non-origin allowedOrigin %j → server_mode.external_url_must_be_origin', (badOrigin) => {
    const d = resolveServerModeExposure({
      externalUrl: 'https://example.com',
      allowedOrigins: [badOrigin],
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.external_url_must_be_origin')
  })

  it('valid https origin + https allowedOrigins → ok', () => {
    const d = resolveServerModeExposure({
      externalUrl: 'https://example.com',
      allowedOrigins: ['https://app.example.com'],
    })
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.publicBaseUrl).toBe('https://example.com')
      expect(d.allowedOrigins).toEqual(['https://app.example.com'])
    }
  })

  it('accepts a wildcard subdomain pattern in allowedOrigins as a pattern, not a literal exact origin', () => {
    const d = resolveServerModeExposure({
      externalUrl: 'https://example.com',
      allowedOrigins: ['https://*.example.com'],
    })
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.allowedOrigins).toEqual(['https://*.example.com'])
      expect(isAllowed('https://preview.example.com', d.allowedOrigins)).toBe(true)
    }
  })

  it('rejects a structurally invalid wildcard pattern in allowedOrigins', () => {
    const d = resolveServerModeExposure({
      externalUrl: 'https://example.com',
      allowedOrigins: ['https://foo*.example.com'],
    })
    expect(d.ok).toBe(false)
  })

  it('allowedOrigins are URL-normalised (explicit :443 / uppercase host) for canonical exact-match', () => {
    // Regression (security LOW-2): stored allowedOrigins must be new URL(o).origin so the
    // per-request exact-match compares canonical forms; an operator's https://App.Example.com:443
    // must not false-deny the browser's canonical https://app.example.com.
    const d = resolveServerModeExposure({
      externalUrl: 'https://example.com',
      allowedOrigins: ['https://App.Example.com:443'],
    })
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.allowedOrigins).toEqual(['https://app.example.com'])
      expect(isAllowed('https://app.example.com', d.allowedOrigins)).toBe(true)
    }
  })

  it('valid https origin without trailing slash → publicBaseUrl equals origin', () => {
    const d = resolveServerModeExposure({
      externalUrl: 'https://api.example.com',
    })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.publicBaseUrl).toBe('https://api.example.com')
  })

  it('https origin with non-default port → preserved in publicBaseUrl', () => {
    const d = resolveServerModeExposure({
      externalUrl: 'https://example.com:8443',
    })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.publicBaseUrl).toBe('https://example.com:8443')
  })

  it('empty allowedOrigins is valid — no browser clients, still ok', () => {
    const d = resolveServerModeExposure({
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
      externalUrl: 'https://example.com',
      allowedOrigins: [`https://user:${CANARY}@app.example.com`],
    })
    expect(d.ok).toBe(false)
    const serialized = JSON.stringify(d)
    expect(serialized).not.toContain(CANARY)
  })

  it('http rejection does not echo the raw URL', () => {
    const d = resolveServerModeExposure({
      externalUrl: 'http://internal.corp.example.com',
    })
    expect(d.ok).toBe(false)
    const serialized = JSON.stringify(d)
    expect(serialized).not.toContain('internal.corp.example.com')
  })
})

// ── per-request origin allowlist check ──────────────────────────────────────

describe('per-request origin allowlist (parseOriginPatterns + matchOrigin)', () => {
  it('listed https origin → allowed', () => {
    expect(isAllowed('https://app.example.com', ['https://app.example.com'])).toBe(true)
  })

  it('unlisted origin → not allowed', () => {
    expect(isAllowed('https://evil.example.com', ['https://app.example.com'])).toBe(false)
  })

  it('empty allowedOrigins → not allowed', () => {
    expect(isAllowed('https://app.example.com', [])).toBe(false)
  })

  it('exact match required — subdomain mismatch is rejected', () => {
    expect(isAllowed('https://sub.app.example.com', ['https://app.example.com'])).toBe(false)
  })

  it('wildcard subdomain pattern admits a matching origin', () => {
    // Regression: a wildcard entry surviving resolveServerModeExposure as a
    // pattern string must actually admit real subdomains, not silently
    // never-match the way a naive new URL(entry).origin + exact-Set lookup
    // would (new URL('https://*.example.com') parses without throwing).
    expect(isAllowed('https://preview.example.com', ['https://*.example.com'])).toBe(true)
  })

  it('wildcard subdomain pattern rejects a non-matching origin', () => {
    expect(isAllowed('https://evil.com', ['https://*.example.com'])).toBe(false)
  })
})

// ── Deterministic anchors ────────────────────────────────────────────────────

describe('resolveServerModeExposure — deterministic contract anchors', () => {
  it('externalUrl with empty username and non-empty password → external_url_must_be_origin', () => {
    const d = resolveServerModeExposure({
      externalUrl: 'https://:secret@example.com',
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.external_url_must_be_origin')
  })

  it('allowedOrigin with empty username and non-empty password → external_url_must_be_origin', () => {
    const d = resolveServerModeExposure({
      externalUrl: 'https://example.com',
      allowedOrigins: ['https://:secret@app.example.com'],
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.code).toBe('server_mode.external_url_must_be_origin')
  })

  it('allowedOrigin with completely unparseable string → external_url_must_be_origin', () => {
    const d = resolveServerModeExposure({
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
// Shared by the property and by the pinned counterexample below, so a regression in the assertion
// itself is caught deterministically rather than only on the seeds that happen to generate a
// colliding host.
function assertRejectedWithoutEcho({
  host,
  suffix,
  kind,
}: {
  host: string
  suffix: string
  kind: 'query' | 'fragment' | 'credentials'
}) {
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
    externalUrl: url,
  })
  expect(d.ok).toBe(false)
  const serialized = JSON.stringify(d)
  // The canary and the full URL must not appear in the failure decision.
  expect(serialized).not.toContain(canary)
  expect(serialized).not.toContain(url)
}

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
  (input) => assertRejectedWithoutEcho(input),
)

// The shrunk counterexample from the property above, pinned as an example: `e.ex` is a substring
// of the failure's own constant code (`server_mod<e.ex>ternal_url_must_be_origin`), so asserting
// the bare host collides with a token the decision is entitled to contain. Nothing leaked — the
// assertion was wrong, and only some seeds reach a host short enough to expose it.
it('does not treat a host that is a substring of the failure code as a leak', () => {
  assertRejectedWithoutEcho({ host: 'e.ex', suffix: '10000000', kind: 'query' })
})

// Property 2: any accepted server-mode decision has an origin-only publicBaseUrl.
fcTest.prop(
  [
    fc.record({
      // Generate a simple hostname (domain), avoiding unusual URL edge cases
      host: fc.domain(),
    }),
  ],
  withDefaults(),
)('accepted server-mode decision always has an https origin-only publicBaseUrl', ({ host }) => {
  const externalUrl = `https://${host}`
  const d: ServerModeExposureDecision = resolveServerModeExposure({
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
})

it('a decision carries exactly the validated origins, nothing of the bind or the data dir', () => {
  const d = resolveServerModeExposure({
    externalUrl: 'https://app.example.com',
    allowedOrigins: ['https://app.example.com'],
  })
  expect(d.ok).toBe(true)
  expect(Object.keys(d).sort()).toEqual(['allowedOrigins', 'ok', 'publicBaseUrl'])
})

fcTest.prop(
  [
    fc.array(
      fc
        .oneof(fc.constant(443), fc.integer({ min: 1024, max: 65535 }))
        .map((port) => `https://host-example.com:${port}`),
      { minLength: 1, maxLength: 4 },
    ),
  ],
  withDefaults(),
)('every accepted allowedOrigin equals its own URL.origin', (origins) => {
  const d = resolveServerModeExposure({
    externalUrl: 'https://app.example.com',
    allowedOrigins: origins,
  })
  if (!d.ok) return
  for (const origin of d.allowedOrigins) {
    expect(origin).toBe(new URL(origin).origin)
    expect(origin.startsWith('https://')).toBe(true)
  }
})
