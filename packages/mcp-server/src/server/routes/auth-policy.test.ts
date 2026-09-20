import { describe, expect, it } from 'vitest'
import { ALL_AUTH_SCOPES } from '../security/auth-strategy.js'
import type { ResolvedGrant } from '../security/credential-resolver.js'
import { grantCoversRoute } from './auth.js'

// `grantCoversRoute` takes the route's DECISION rather than resolving it, and
// this file is why. `daemon-token-only` is produced by no route in the
// registry, so a policy that resolved a path internally could only be reached
// by mocking — and it was not reached at all: inverting that branch left all
// 487 route tests green when it was measured.
const grant = (kind: ResolvedGrant['kind'], scopes: ResolvedGrant['scopes']): ResolvedGrant => ({
  kind,
  scopes,
})

describe('grantCoversRoute — full authority does not consult the registry', () => {
  it.each(['anonymous', 'daemon-token'] as const)('%s covers every decision', (kind) => {
    const full = grant(kind, ALL_AUTH_SCOPES)

    expect(grantCoversRoute(full, null)).toBe(true)
    expect(grantCoversRoute(full, { kind: 'public' })).toBe(true)
    expect(grantCoversRoute(full, { kind: 'daemon-token-only' })).toBe(true)
    expect(grantCoversRoute(full, { kind: 'scoped', scopes: ['runtime:admin'] })).toBe(true)
  })
})

describe('grantCoversRoute — a narrow credential is judged by the decision', () => {
  const narrow = grant('oauth-grant', ['canvas:read'])

  it('fails closed on an undeclared route', () => {
    // A route added later must be given a scope deliberately, never inherit
    // one by accident.
    expect(grantCoversRoute(narrow, null)).toBe(false)
  })

  it('passes a public route', () => {
    expect(grantCoversRoute(narrow, { kind: 'public' })).toBe(true)
  })

  it('needs every scope the route declares, not just one', () => {
    expect(grantCoversRoute(narrow, { kind: 'scoped', scopes: ['canvas:read'] })).toBe(true)
    expect(grantCoversRoute(narrow, { kind: 'scoped', scopes: ['canvas:write'] })).toBe(false)
    expect(
      grantCoversRoute(narrow, { kind: 'scoped', scopes: ['canvas:read', 'canvas:write'] }),
    ).toBe(false)
  })
})

// ADR-0043 decision 8's promoted rule, and the branch no route can reach.
// A route whose purpose is handing out daemon-level authority must not be
// reachable by a credential narrower than what it hands out, or that
// credential can mint a path back to the full one.
describe('grantCoversRoute — daemon-token-only refuses every narrow credential', () => {
  it.each([
    ['oauth-grant', ['runtime:admin']],
    ['pairing', ALL_AUTH_SCOPES],
    ['macaroon', ALL_AUTH_SCOPES],
    ['ws-ticket', ALL_AUTH_SCOPES],
  ] as const)('refuses %s even holding %j', (kind, scopes) => {
    expect(grantCoversRoute(grant(kind, scopes), { kind: 'daemon-token-only' })).toBe(false)
  })

  // The one that was silently exempt before the unification: the pairing
  // token skipped the registry entirely, so it alone could have reached such
  // a route. Holding the FULL scope set is exactly why the kind has to decide
  // this rather than the scopes.
  it('refuses a pairing token holding the full scope set', () => {
    expect(grantCoversRoute(grant('pairing', ALL_AUTH_SCOPES), { kind: 'daemon-token-only' })).toBe(
      false,
    )
  })
})
