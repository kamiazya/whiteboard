import {
  type DaemonConnectionPayload,
  daemonConnectionPayloadSchema,
  decodeBase64UrlText,
  encodeBase64UrlText,
  DAEMON_CONNECTION_FRAGMENT_KEY as FRAGMENT_KEY,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import type { z } from 'zod'

export type { DaemonConnectionPayload }
// The payload schema and its base64url fragment codec are declared ONCE in
// mcp-server's shared api-contracts, not here: the tool that mints a pairing
// link (wb_pairing_link_create) and this parser used to keep two
// independently hand-written copies, which is exactly the shape that drifts
// silently. Re-exported so existing importers of this module keep working.
export { daemonConnectionPayloadSchema }

export type ParseDaemonConnectionFragmentResult =
  | { status: 'ok'; payload: DaemonConnectionPayload }
  | { status: 'not-present' }
  | { status: 'malformed'; stage: 'base64' | 'json'; message: string }
  | { status: 'invalid'; issues: z.ZodIssue[] }

// Extracts the raw `wb` fragment value from a location.hash-shaped string, tolerant of
// a missing leading '#' and of other unrelated fragment params sharing the hash.
//
// Segment keys are compared as raw strings (no percent-decoding) rather than via
// URLSearchParams, which would decode a key like `%77%62` to `wb` and accept it.
// removeFragmentKey() below does the same raw comparison to strip a consumed token
// from the URL, so a percent-encoded key must be rejected here too — otherwise a
// payload could be parsed but never cleaned up, leaving a bootstrapToken lingering
// in window.location.hash.
function extractFragmentValue(hash: string): string | null {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash
  if (withoutHash.length === 0) return null
  for (const segment of withoutHash.split('&')) {
    const separatorIndex = segment.indexOf('=')
    const key = separatorIndex === -1 ? segment : segment.slice(0, separatorIndex)
    if (key !== FRAGMENT_KEY) continue
    return separatorIndex === -1 ? '' : segment.slice(separatorIndex + 1)
  }
  return null
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
    decoded = decodeBase64UrlText(raw)
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
  return `#${FRAGMENT_KEY}=${encodeBase64UrlText(json)}`
}

// Removes only the `wb=...` segment from a location.hash-shaped string, leaving any
// other '&'-joined segments (e.g. `fullscreen`) untouched and in their original form.
function removeFragmentKey(hash: string): string {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash
  return withoutHash
    .split('&')
    .filter((segment) => segment.split('=')[0] !== FRAGMENT_KEY)
    .join('&')
}

// Strips the `wb=...` segment from the current URL's hash via history.replaceState so a
// consumed bootstrapToken never lingers in browser history or a shared/screen-recorded URL.
// Other hash segments sharing the fragment (e.g. `#fullscreen&wb=...`) are preserved —
// mirrors the hash-ownership pattern in canvas-fullscreen-hash.ts.
export function consumeDaemonConnectionFragment(): void {
  // Guard against non-DOM contexts (SSR, a Node-side import that never set up
  // jsdom) so the module is safe to reference anywhere, not just in the browser.
  if (typeof window === 'undefined') return
  if (window.location.hash.length === 0) return
  const url = new URL(window.location.href)
  url.hash = removeFragmentKey(url.hash)
  window.history.replaceState(window.history.state, '', url.toString())
}
