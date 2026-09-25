/**
 * ADR-0046 decision 2: who a trusted reverse proxy says is signing in.
 *
 * The position is checked first and on the IMMEDIATE peer, the socket's own
 * address: a forwarded-for header is written by whoever sent the request, so
 * reading one would let any caller claim to be the proxy. Only then is the
 * identity read, from a signed assertion checked against the proxy's keys or
 * from a bare header the operator vouches the proxy overwrites.
 *
 * The result is claims for `completeSignIn`, which decides everything else
 * — admission, invitations, creation — exactly as for an OIDC sign-in.
 */
import { BlockList, isIP } from 'node:net'
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'
import type { VerifiedClaims } from './sign-in-admission.js'
import type { TrustedHeaderProvider } from './sign-in-config.js'

export interface TrustedHeaderRequest {
  /** The socket's remote address; undefined when the runtime has none. */
  readonly peer: string | undefined
  readonly header: (name: string) => string | undefined
}

export type TrustedIdentity =
  | { readonly ok: true; readonly claims: VerifiedClaims }
  | { readonly ok: false; readonly why: 'untrusted_peer' | 'no_identity' | 'assertion_invalid' }

// The algorithms the surveyed proxies sign with. Pinned here rather than taken
// from the key set, so a key published with a weaker `alg` cannot widen it.
const ASSERTION_ALGORITHMS = ['RS256', 'ES256']
// Small: the proxy mints the assertion for this very request.
const ASSERTION_CLOCK_TOLERANCE_S = 30

function trustedPeers(addresses: readonly string[]): (peer: string | undefined) => boolean {
  const list = new BlockList()
  for (const entry of addresses) {
    const [address = '', prefix] = entry.split('/')
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6'
    if (prefix === undefined) list.addAddress(address, family)
    else list.addSubnet(address, Number(prefix), family)
  }
  return (peer) => {
    if (peer === undefined) return false
    const family = isIP(peer)
    if (family === 0) return false
    // BlockList matches a dual-stack socket's `::ffff:a.b.c.d` against an
    // IPv4 entry itself; the test for that form holds it to it.
    return list.check(peer, family === 4 ? 'ipv4' : 'ipv6')
  }
}

function headerValue(request: TrustedHeaderRequest, name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  const value = request.header(name)?.trim()
  return value === undefined || value === '' ? undefined : value
}

function bareIdentity(
  identity: NonNullable<TrustedHeaderProvider['identity']>,
  request: TrustedHeaderRequest,
): TrustedIdentity {
  const sub = headerValue(request, identity.subjectHeader)
  if (sub === undefined) return { ok: false, why: 'no_identity' }
  const email = headerValue(request, identity.emailHeader)
  const name = headerValue(request, identity.nameHeader)
  return {
    ok: true,
    claims: {
      sub,
      ...(email === undefined ? {} : { email, email_verified: identity.emailVerified }),
      ...(name === undefined ? {} : { name }),
    },
  }
}

async function signedIdentity(
  assertion: NonNullable<TrustedHeaderProvider['assertion']>,
  keys: JWTVerifyGetKey,
  request: TrustedHeaderRequest,
): Promise<TrustedIdentity> {
  const token = headerValue(request, assertion.header)
  if (token === undefined) return { ok: false, why: 'no_identity' }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: assertion.issuer,
      audience: assertion.audience,
      algorithms: ASSERTION_ALGORITHMS,
      clockTolerance: ASSERTION_CLOCK_TOLERANCE_S,
      requiredClaims: ['exp', 'sub'],
    })
    return { ok: true, claims: payload }
  } catch {
    // Why is not returned: jose's message can carry the token's contents.
    return { ok: false, why: 'assertion_invalid' }
  }
}

/**
 * One reader per provider, built at startup, so the address list is parsed
 * and the proxy's key set fetched once. `keys` replaces the remote key set in
 * tests.
 */
export function createTrustedIdentityReader(
  provider: TrustedHeaderProvider,
  keys?: JWTVerifyGetKey,
): (request: TrustedHeaderRequest) => Promise<TrustedIdentity> {
  const trusted = trustedPeers(provider.trustedAddresses)
  const { assertion, identity } = provider
  const keySet =
    assertion === undefined ? undefined : (keys ?? createRemoteJWKSet(new URL(assertion.jwksUri)))
  return async (request) => {
    if (!trusted(request.peer)) return { ok: false, why: 'untrusted_peer' }
    if (assertion !== undefined && keySet !== undefined) {
      return signedIdentity(assertion, keySet, request)
    }
    if (identity !== undefined) return bareIdentity(identity, request)
    return { ok: false, why: 'no_identity' }
  }
}
