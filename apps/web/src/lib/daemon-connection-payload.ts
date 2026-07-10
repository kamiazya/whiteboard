import { z } from 'zod'
import { bareOriginSchema } from '../runtime-config.js'

// URL hash key carrying the daemon-pairing payload: `#wb=<base64url-json>`.
const FRAGMENT_KEY = 'wb'

// Minimum bootstrapToken length is a defense-in-depth floor, not the real security
// boundary — the daemon itself decides whether a bootstrapToken is valid and
// exchanges it for a short-lived sessionToken (see ADR-0002).
const MIN_BOOTSTRAP_TOKEN_LENGTH = 8

// bareOriginSchema alone permits any URL scheme (ws:, file:, etc.); daemon pairing is
// restricted to http(s) since that is the only transport ADR-0002 defines.
const daemonBaseUrlSchema = bareOriginSchema.refine(
  (v) => v.startsWith('http://') || v.startsWith('https://'),
  { message: 'baseUrl must use http or https' },
)

// authMode is a literal union rather than a bare string so new modes require an
// explicit schema change instead of silently round-tripping unknown values.
export const daemonConnectionPayloadSchema = z
  .object({
    baseUrl: daemonBaseUrlSchema,
    workspaceId: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    bootstrapToken: z.string().min(MIN_BOOTSTRAP_TOKEN_LENGTH).optional(),
    authMode: z.enum(['bootstrap', 'none']),
    fullscreen: z.boolean().optional(),
  })
  .strict()

export type DaemonConnectionPayload = z.infer<typeof daemonConnectionPayloadSchema>

export type ParseDaemonConnectionFragmentResult =
  | { status: 'ok'; payload: DaemonConnectionPayload }
  | { status: 'not-present' }
  | { status: 'malformed'; stage: 'base64' | 'json'; message: string }
  | { status: 'invalid'; issues: z.ZodIssue[] }

// Decodes a base64url string to its original UTF-8 text.
// Throws on invalid base64url input (surfaced by the caller as a 'malformed' result).
function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const paddingLength = (4 - (base64.length % 4)) % 4
  const padded = base64 + '='.repeat(paddingLength)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

// Encodes UTF-8 text to a base64url string (no padding), matching the `#wb=` fragment format.
function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Extracts the raw `wb` fragment value from a location.hash-shaped string, tolerant of
// a missing leading '#' and of other unrelated fragment params sharing the hash.
function extractFragmentValue(hash: string): string | null {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash
  if (withoutHash.length === 0) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(withoutHash)
  } catch {
    return null
  }
  return params.get(FRAGMENT_KEY)
}

// Parses the `#wb=<base64url-json>` daemon-pairing fragment. Never throws — every
// failure mode (absent, malformed encoding, malformed JSON, schema violation) is
// reported as a distinct discriminated-union variant so callers can branch safely.
export function parseDaemonConnectionFragment(hash: string): ParseDaemonConnectionFragmentResult {
  const raw = extractFragmentValue(hash)
  if (raw === null || raw.length === 0) {
    return { status: 'not-present' }
  }

  let decoded: string
  try {
    decoded = decodeBase64Url(raw)
  } catch (err) {
    return {
      status: 'malformed',
      stage: 'base64',
      message: err instanceof Error ? err.message : 'invalid base64url encoding',
    }
  }

  let json: unknown
  try {
    json = JSON.parse(decoded)
  } catch (err) {
    return {
      status: 'malformed',
      stage: 'json',
      message: err instanceof Error ? err.message : 'invalid JSON',
    }
  }

  const result = daemonConnectionPayloadSchema.safeParse(json)
  if (!result.success) {
    return { status: 'invalid', issues: result.error.issues }
  }

  return { status: 'ok', payload: result.data }
}

// Encodes a payload into the `#wb=<base64url-json>` fragment string, including the
// leading '#'. Primarily a test/dev helper for round-tripping parseDaemonConnectionFragment.
export function encodeDaemonConnectionFragment(payload: DaemonConnectionPayload): string {
  const json = JSON.stringify(daemonConnectionPayloadSchema.parse(payload))
  return `#${FRAGMENT_KEY}=${encodeBase64Url(json)}`
}

// Strips the `#wb=...` fragment from the current URL via history.replaceState so a
// consumed bootstrapToken never lingers in browser history or a shared/screen-recorded URL.
export function consumeDaemonConnectionFragment(): void {
  if (window.location.hash.length === 0) return
  const url = new URL(window.location.href)
  url.hash = ''
  window.history.replaceState(window.history.state, '', url.toString())
}
