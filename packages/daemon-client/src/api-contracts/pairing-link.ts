import { z } from 'zod'

// The daemon-pairing URL fragment contract (`#wb=<base64url-json>`), shared
// between the MCP tool that mints the link (server/mcp/pairing-link.ts) and
// the browser that parses it (apps/web/src/lib/daemon-connection-payload.ts)
// so the wire shape cannot drift between two independently-written schemas —
// the failure mode a mirrored copy had before this file existed. Deliberately
// free of any node:* import: apps/web consumes this module directly.

// URL hash key carrying the daemon-pairing payload: `#wb=<base64url-json>`.
export const DAEMON_CONNECTION_FRAGMENT_KEY = 'wb'

// Minimum bootstrapToken length is a defense-in-depth floor, not the real
// security boundary — the daemon itself decides whether a bootstrapToken is
// valid. The token is the daemon's full-authority bearer credential, live
// until rotated (ADR-0002): it is NOT exchanged for a short-lived session
// token, which is why every surface that emits it carries a credential
// warning.
export const MIN_BOOTSTRAP_TOKEN_LENGTH = 8

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

// authMode is a literal union rather than a bare string so new modes require
// an explicit schema change instead of silently round-tripping unknown values.
export const daemonConnectionPayloadSchema = z
  .object({
    baseUrl: bareHttpOriginSchema,
    workspaceId: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    bootstrapToken: z.string().min(MIN_BOOTSTRAP_TOKEN_LENGTH).optional(),
    authMode: z.enum(['bootstrap', 'none']),
    fullscreen: z.boolean().optional(),
  })
  .strict()
  // ADR-0002's bootstrap pairing exchange has no meaning without a token to
  // exchange, so the schema — not just the docs — enforces the pairing.
  .refine((payload) => payload.authMode !== 'bootstrap' || payload.bootstrapToken !== undefined, {
    message: 'bootstrapToken is required when authMode is "bootstrap"',
    path: ['bootstrapToken'],
  })
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
