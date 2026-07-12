// The exact-URI redirect_uri registry for the hosted-origin OAuth 2.1
// authorization server (ADR-0005).
//
// This is deliberately its own config, not derived from
// WHITEBOARD_ALLOWED_WEB_ORIGINS: that env var stores *origins* (scheme +
// host, no path) and permits leftmost-label wildcard subdomain patterns
// (see origin-pattern.ts) — `https://*.pages.dev` there means "any Pages
// project", which is exactly the admission an OAuth redirect_uri registry
// must never grant. A redirect_uri carries an exact callback *path*, and
// matching it against anything looser than byte-for-byte equality is the
// open-redirect class of bug: a substring/prefix match would let
// `https://whiteboard.pages.dev/oauth/callback/evil` piggyback on a
// registered `https://whiteboard.pages.dev/oauth/callback`.
//
// No dynamic client registration (RFC 7591) — clients are fixed entries
// configured by the operator, matched by clientId first, then by exact
// redirectUris membership.

import { z } from 'zod'

// RFC 8252 §7.3 / §8.3: `http` is admissible only for a loopback *IP literal*
// redirect. `localhost` is included alongside them because the hosted web
// client is itself developed against a loopback dev server, and an operator
// who could not register that callback could never exercise the flow before
// deploying it. The host is compared against this exact set — never a suffix
// — so `localhost.evil.com` and `127.0.0.1.evil.com` do not qualify.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost'])

// `new URL('https://*.pages.dev/callback')` parses successfully — WHATWG
// URL parsing treats '*' as a literal (if unusual) hostname character
// rather than rejecting it — so `z.string().url()` alone does NOT
// foreclose a wildcard-origin entry sneaking into this registry. Reject
// '*' explicitly; this registry has no pattern-matching concept at all,
// unlike origin-pattern.ts's wildcard-subdomain support for
// WHITEBOARD_ALLOWED_WEB_ORIGINS.
const exactRedirectUriSchema = z
  .string()
  .url()
  .refine((value) => !value.includes('*'), {
    message: 'redirect_uri entries must be exact URIs; wildcards are not supported',
  })
  // RFC 6749 §3.1.2: "The redirection endpoint URI MUST be an absolute URI …
  // The endpoint URI MUST NOT include a fragment component." The authorization
  // response appends its own fragment/query; a registered fragment would make
  // the delivered URI un-derivable and, worse, byte-for-byte comparison against
  // a fragment-bearing entry silently diverges from what the browser sends
  // (the fragment never leaves the client).
  .refine((value) => !value.includes('#'), {
    message: 'redirect_uri entries must not include a fragment component (RFC 6749 §3.1.2)',
  })
  // RFC 6749 §3.1.2.1: the redirection endpoint SHOULD require TLS. An
  // authorization code delivered over cleartext to a non-loopback host is
  // readable by any network observer, and PKCE does not protect the code's
  // confidentiality on the wire — it only stops a stolen code being redeemed
  // without the verifier.
  .refine(
    (value) => {
      const url = new URL(value)
      if (url.protocol === 'https:') return true
      if (url.protocol !== 'http:') return false
      return LOOPBACK_HOSTNAMES.has(url.hostname)
    },
    {
      message: 'redirect_uri entries must use https, or http only on a loopback host',
    },
  )

export const oauthClientRegistryEntrySchema = z.object({
  clientId: z.string().min(1),
  redirectUris: z.array(exactRedirectUriSchema).min(1),
})

export const oauthClientRegistrySchema = z.array(oauthClientRegistryEntrySchema)

export type OAuthClientRegistryEntry = z.infer<typeof oauthClientRegistryEntrySchema>
export type OAuthClientRegistry = z.infer<typeof oauthClientRegistrySchema>

// Byte-for-byte comparison only. Do not normalize, decode, lowercase, or
// strip trailing slashes before comparing — any such normalization step is
// exactly the kind of "helpful" transform that turns an exact-match
// registry back into a fuzzy one.
export function isRegisteredRedirectUri(
  registry: OAuthClientRegistry,
  clientId: string,
  redirectUri: string,
): boolean {
  const entry = registry.find((candidate) => candidate.clientId === clientId)
  if (!entry) return false
  return entry.redirectUris.includes(redirectUri)
}

export type ParseOAuthClientRegistryEnvResult =
  | { ok: true; registry: OAuthClientRegistry }
  | { ok: false; error: string }

// WHITEBOARD_OAUTH_CLIENT_REGISTRY: a JSON array of { clientId, redirectUris }.
// Unset/empty is a valid, empty registry — the hosted-origin AS surface
// stays entirely inert (every redirect_uri check fails closed) until an
// operator opts in, matching the empty-by-default posture of
// WHITEBOARD_ALLOWED_WEB_ORIGINS.
export function parseOAuthClientRegistryEnv(
  raw: string | undefined,
): ParseOAuthClientRegistryEnvResult {
  if (!raw || raw.trim() === '') return { ok: true, registry: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  const result = oauthClientRegistrySchema.safeParse(parsed)
  if (!result.success) return { ok: false, error: 'schema validation failed' }
  return { ok: true, registry: result.data }
}
