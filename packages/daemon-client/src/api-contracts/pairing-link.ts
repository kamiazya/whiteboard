import { z } from 'zod'

// The daemon-pairing URL fragment contract (`#wb=<base64url-json>`), shared
// between the MCP tool that mints the link (server/mcp/pairing-link.ts) and
// the browser that parses it (apps/web/src/lib/daemon-connection-payload.ts)
// so the wire shape cannot drift between two independently-written schemas —
// the failure mode a mirrored copy had before this file existed. Deliberately
// free of any node:* import: apps/web consumes this module directly.

// URL hash key carrying the daemon-pairing payload: `#wb=<base64url-json>`.
export const DAEMON_CONNECTION_FRAGMENT_KEY = 'wb'

// Bare http(s) origin: scheme + host + optional port, nothing else. Daemon
// pairing (ADR-0002) never uses another scheme, and never carries a path,
// query, hash, credentials, or a wildcard host. Exported so the MCP tool's
// webOrigin input validates against the same predicate as this schema.
export function isBareHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.origin === value &&
      !url.hostname.includes('*') &&
      (url.protocol === 'http:' || url.protocol === 'https:')
    )
  } catch {
    return false
  }
}

const bareHttpOriginSchema = z.string().url().refine(isBareHttpOrigin, {
  message:
    'must be a bare http(s) origin (scheme + host + optional port, no path, query, hash, credentials, or wildcards)',
})

// A pairing link carries NO credential. It names a daemon and, optionally,
// what to open once paired; the browser then obtains an origin-scoped session
// token through the pairing-grant flow (an approval on the daemon's own /pair
// page, or a silent renewal when this origin already holds a grant).
//
// It used to carry `authMode` and `bootstrapToken` — the daemon's own
// full-authority bearer credential, live until rotated, embedded verbatim in
// a URL that travels through chat logs, shell history and screen shares. That
// is what the field set below removes. `.strict()` is what makes the removal
// enforceable rather than advisory: a link minted by an older daemon still
// carries those keys, so it is REFUSED here instead of being parsed and
// silently used, and the browser strips such a fragment from history on the
// invalid path exactly as it does for a valid one.
//
// Split in two so the BROWSER can stash what to open across the consent
// round trip without a second hand-written copy of these three fields: the
// link's target survives a top-level navigation to the daemon's /pair page
// and back, and `pairing-grant.ts` validates the stash with this same
// schema.
export const daemonConnectionTargetSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  fullscreen: z.boolean().optional(),
})

export type DaemonConnectionTarget = z.infer<typeof daemonConnectionTargetSchema>

export const daemonConnectionPayloadSchema = daemonConnectionTargetSchema
  .extend({ baseUrl: bareHttpOriginSchema })
  .strict()
  // A document is addressed by the (workspaceId, path) pair, so a path is
  // meaningless without a workspaceId. workspaceId alone is a valid
  // workspace-level target, so the constraint is one-directional.
  .refine((payload) => payload.path === undefined || payload.workspaceId !== undefined, {
    message: 'workspaceId is required when path is set',
    path: ['workspaceId'],
  })

export type DaemonConnectionPayload = z.infer<typeof daemonConnectionPayloadSchema>

// Runtime-agnostic base64url text codec (TextEncoder/TextDecoder + btoa/atob):
// no Buffer, so this holds in Node, the browser, and a worker alike. Node's
// 'base64url' Buffer encoding and this pair produce byte-identical output for
// the same UTF-8 text, which is what lets the tool (Node) and the browser
// parser share one fragment format without a second implementation to drift.

// Encodes UTF-8 text to a base64url string (no padding), matching the `#wb=`
// fragment format.
export function encodeBase64UrlText(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Decodes a base64url string to its original UTF-8 text. Throws on invalid
// base64url input.
export function decodeBase64UrlText(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const paddingLength = (4 - (base64.length % 4)) % 4
  const padded = base64 + '='.repeat(paddingLength)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
