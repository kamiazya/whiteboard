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
