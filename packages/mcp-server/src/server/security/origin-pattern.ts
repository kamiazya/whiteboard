// Shared pure origin-pattern parser/matcher used by both allowlist paths
// (local-daemon web-origin-allowlist.ts and server-mode's exposure/auth-plan/
// app.ts sites). A pattern is either an exact https(s) origin or a
// leftmost-label wildcard subdomain pattern (https://*.example.com).
//
// Wildcard contract (non-negotiable):
//   - Bare '*' is always rejected — this module never treats '*' alone as
//     "allow everything".
//   - The wildcard may appear ONLY as the entire leftmost label of an
//     https:// origin. No mid-label (foo*.example.com), no multi-wildcard
//     (*.*.example.com), no wildcard in the static suffix.
//   - The static suffix after the wildcard must retain at least two labels
//     (example.com, not just .dev) — this is a structural check, not a
//     public-suffix-list lookup. https://*.pages.dev passes this check yet
//     admits every Cloudflare Pages project; callers must document that
//     residual risk to operators rather than relying on this module to catch it.
//   - Exactly ONE label is matched: {x}.example.com matches, {x}.{y}.example.com
//     does not. This is the conservative default for the Cloudflare Pages
//     preview shape (https://*.<project>.pages.dev) this module was built for.
//   - Scheme must be https:// for wildcard patterns; loopback http origins
//     never need wildcards.
//   - IP-literal / bracketed-IPv6 hosts never participate in wildcard
//     matching, on either the pattern or the request-origin side.
//   - Host comparison relies on WHATWG URL parsing normalizing case and IDN
//     to lowercase punycode identically on both the pattern and the request
//     side. A Unicode-spelled pattern entry is therefore accepted and
//     punycode-normalized automatically (documented, not special-cased) —
//     operators are still encouraged to write patterns in ASCII/punycode form.
//   - A trailing dot on either the pattern suffix or the request host is
//     rejected (pattern side) or simply never matches (request side) —
//     trailing-dot hostnames are not treated as equivalent to their
//     dotless form.
//   - Port comparison relies on WHATWG URL parsing stripping the default
//     port (443) identically on both sides, so an explicit ":443" pattern
//     or request origin compares equal to a portless one.

import { z } from 'zod'
import { validateOriginEntry } from './origin-validation.js'

const exactOriginPatternSchema = z.object({
  kind: z.literal('exact'),
  origin: z.string(),
})

const wildcardOriginPatternSchema = z.object({
  kind: z.literal('wildcard-subdomain'),
  // Lowercased, punycode, dot-joined static suffix with no leading/trailing
  // dot, e.g. "example.com" or "kamiazya-whiteboard.pages.dev".
  suffixHost: z.string(),
  // Empty string means "no explicit port" (i.e. the https default of 443).
  port: z.string(),
})

export const originPatternSchema = z.discriminatedUnion('kind', [
  exactOriginPatternSchema,
  wildcardOriginPatternSchema,
])

export type OriginPattern = z.infer<typeof originPatternSchema>

export type OriginPatternFailureReason =
  | 'unparseable'
  | 'wildcard'
  | 'not_https'
  | 'not_origin'
  | 'wildcard_not_leftmost'
  | 'wildcard_multi_label'
  | 'wildcard_suffix_too_short'
  | 'wildcard_ip_suffix'

export type OriginPatternParseResult =
  | { ok: true; pattern: OriginPattern }
  | { ok: false; reason: OriginPatternFailureReason }

const IPV4_LIKE = /^\d{1,3}(\.\d{1,3}){3}$/

function isIpLiteralSuffix(suffix: string): boolean {
  return IPV4_LIKE.test(suffix)
}

// Parses a single configured allowlist entry that may be an exact https(s)
// origin or a leftmost-label wildcard subdomain pattern. Exact entries are
// delegated to the shared neutral validator so both callers keep identical
// exact-origin semantics; wildcard entries get the structural checks
// documented in this module's header.
export function parseOriginPatternEntry(entry: string): OriginPatternParseResult {
  if (entry === '*') return { ok: false, reason: 'wildcard' }

  if (!entry.includes('*')) {
    const result = validateOriginEntry(entry)
    if (!result.ok) return { ok: false, reason: result.reason }
    return { ok: true, pattern: { kind: 'exact', origin: result.origin } }
  }

  let parsed: URL
  try {
    parsed = new URL(entry)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }

  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not_https' }

  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return { ok: false, reason: 'not_origin' }
  }

  const hostname = parsed.hostname
  // A bracketed IPv6 host (e.g. "[::1]") never carries a leading "*."
  // label — this also rejects any attempt to smuggle a wildcard alongside
  // an IP-literal host.
  const labels = hostname.split('.')
  if (labels[0] !== '*') return { ok: false, reason: 'wildcard_not_leftmost' }

  const restLabels = labels.slice(1)
  if (restLabels.some((label) => label.includes('*'))) {
    return { ok: false, reason: 'wildcard_multi_label' }
  }
  // A trailing dot on the pattern (e.g. "https://*.example.com.") produces
  // an empty final label — reject rather than silently normalizing it away.
  if (restLabels.some((label) => label.length === 0)) {
    return { ok: false, reason: 'unparseable' }
  }
  if (restLabels.length < 2) return { ok: false, reason: 'wildcard_suffix_too_short' }

  // Defense in depth only: WHATWG URL parsing already throws before this
  // point for the common case of an IPv4-shaped suffix (e.g.
  // "*.127.0.0.1" fails to parse as a URL at all, surfacing as
  // 'unparseable' above), but this catches any suffix that manages to
  // reach here looking like a bare IPv4 address.
  const suffixHost = restLabels.join('.')
  if (isIpLiteralSuffix(suffixHost)) return { ok: false, reason: 'wildcard_ip_suffix' }

  const pattern = originPatternSchema.parse({
    kind: 'wildcard-subdomain',
    suffixHost,
    port: parsed.port,
  })
  return { ok: true, pattern }
}

// Reconstructs the canonical string form of a pattern so callers that keep
// allowlists as readonly string[] (for env/config round-tripping) don't
// re-derive the "https://*.<suffix>[:<port>]" format themselves.
export function formatOriginPatternEntry(pattern: OriginPattern): string {
  if (pattern.kind === 'exact') return pattern.origin
  const portSuffix = pattern.port ? `:${pattern.port}` : ''
  return `https://*.${pattern.suffixHost}${portSuffix}`
}

// Re-derives the canonical string form of an already-validated allowlist
// entry. Safe to call on entries produced by parseOriginPatternEntry;
// returns the input unchanged if it somehow fails to re-parse (defensive
// only — upstream validation should already guarantee success).
export function canonicalizeOriginPatternEntry(entry: string): string {
  const result = parseOriginPatternEntry(entry)
  return result.ok ? formatOriginPatternEntry(result.pattern) : entry
}

// Per-request matcher shared by every origin-admission surface. `patterns`
// must already be parsed (via parseOriginPatternEntry) from a validated
// allowlist — this function does no validation of its own.
export function matchOrigin(
  patterns: readonly OriginPattern[],
  originHeader: string | undefined,
): boolean {
  if (!originHeader) return false

  let parsed: URL
  try {
    parsed = new URL(originHeader)
  } catch {
    return false
  }

  for (const pattern of patterns) {
    if (pattern.kind === 'exact') {
      if (parsed.origin === pattern.origin) return true
      continue
    }

    if (parsed.protocol !== 'https:') continue
    if (parsed.port !== pattern.port) continue

    const labels = parsed.hostname.split('.')
    if (labels.length < 2) continue
    const requestSuffix = labels.slice(1).join('.')
    if (requestSuffix === pattern.suffixHost) return true
  }

  return false
}
