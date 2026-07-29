// Server-mode auth / exposure plan.
//
// Pure helper: maps operator config → a typed plan describing how to wire auth
// and CORS for each deployment mode. Does NOT modify routes, runtime, or state.
//
// Design:
//   local-loopback: no OAuth route auth (single-user concession); PNA 'loopback'
//     policy; routeAuthPlan is null — local-daemon needs no scope enforcement.
//   server-mode: scope-gated route groups; allowedOrigins URL.origin-normalized;
//     PNA 'disabled' (proper HTTPS server needs no Private Network Access header).
//
// allowedOrigins normalization:
//   server-mode-exposure.ts validates the input origins but stores them as-is.
//   This layer re-canonicalizes each accepted origin via
//   origin-pattern.ts's canonicalizeOriginPatternEntry before placing it in
//   the decision. For exact origins this strips default ports (https :443,
//   http :80) so stored origins always match the scheme+host+port format
//   browsers send in the Origin request header; wildcard subdomain patterns
//   pass through unchanged in their canonical "https://*.<suffix>[:port]"
//   form. Never use `new URL(o).origin` directly here — it does not throw on
//   a wildcard entry and would silently treat it as an opaque literal string.
//
// Failure contract:
//   All failure decisions are code-only — no raw URL, credential, path, stack
//   frame, or token appears in the output. Failure codes are delegated from
//   server-mode-exposure.ts and are stable literal values.

import type { AuthScope } from './auth-strategy.js'
import {
  resolveServerModeExposure,
  type ServerModeExposureFailureCode,
  type ServerModeExposureInput,
} from './server-mode-exposure.js'

// Stable identifiers for logical route groups that will be scope-gated.
// Each group maps to exactly one required AuthScope in SERVER_MODE_ROUTE_AUTH_PLAN,
// so callers can check a single scope per resource rather than an AND-combination.
type RouteGroupId =
  | 'canvas-read'
  | 'workspace-read'
  | 'versions-read'
  | 'files-read'
  | 'canvas-write'
  | 'workspace-write'
  | 'versions-write'
  | 'files-write'
  | 'runtime-read'
  | 'runtime-admin'
  | 'mcp'

interface RouteGroupAuthPlan {
  readonly group: RouteGroupId
  readonly requiredScopes: readonly AuthScope[]
}

// PNA (Private Network Access) header policy:
//   'loopback'  — local-daemon must respond to PNA preflight from browser pages
//                 that access the loopback interface.
//   'disabled'  — server-mode runs on a proper HTTPS origin; no PNA header needed.

export type ServerModeAuthPlanDecision =
  | {
      readonly ok: true
      readonly kind: 'local-loopback'
      readonly publicBaseUrl: string
      readonly allowedOrigins: readonly string[]
      readonly trustedProxy: false
      readonly pnaHeader: 'loopback'
      readonly routeAuthPlan: null
    }
  | {
      readonly ok: true
      readonly kind: 'server-mode'
      readonly publicBaseUrl: string
      // URL.origin-normalized: scheme+host+port, default ports stripped.
      readonly allowedOrigins: readonly string[]
      readonly trustedProxy: boolean
      readonly pnaHeader: 'disabled'
      readonly routeAuthPlan: readonly RouteGroupAuthPlan[]
    }
  | { readonly ok: false; readonly code: ServerModeExposureFailureCode }

// First-wave server-mode route auth plan — one scope per resource group so
// callers check exactly the scope required, no over- or under-requirement.
//   runtime-read:  GET /api/runtime/status
//   runtime-admin: POST /api/runtime/touch + POST /api/runtime/shutdown
//     (touch is separated from runtime-read because it mutates daemon state;
//      shutdown is destructive — both require the admin scope, not the read scope)
const SERVER_MODE_ROUTE_AUTH_PLAN: readonly RouteGroupAuthPlan[] = [
  { group: 'canvas-read', requiredScopes: ['canvas:read'] },
  { group: 'workspace-read', requiredScopes: ['workspace:read'] },
  { group: 'versions-read', requiredScopes: ['versions:read'] },
  { group: 'files-read', requiredScopes: ['files:read'] },
  { group: 'canvas-write', requiredScopes: ['canvas:write'] },
  { group: 'workspace-write', requiredScopes: ['workspace:write'] },
  { group: 'versions-write', requiredScopes: ['versions:write'] },
  { group: 'files-write', requiredScopes: ['files:write'] },
  { group: 'runtime-read', requiredScopes: ['runtime:read'] },
  { group: 'runtime-admin', requiredScopes: ['runtime:admin'] },
  { group: 'mcp', requiredScopes: ['mcp:call'] },
]

export function planServerModeAuth(input: ServerModeExposureInput): ServerModeAuthPlanDecision {
  const exposure = resolveServerModeExposure(input)

  if (!exposure.ok) {
    return { ok: false, code: exposure.code }
  }

  if (exposure.kind === 'local-loopback') {
    return {
      ok: true,
      kind: 'local-loopback',
      publicBaseUrl: exposure.publicBaseUrl,
      allowedOrigins: exposure.allowedOrigins,
      trustedProxy: false,
      pnaHeader: 'loopback',
      routeAuthPlan: null,
    }
  }

  // Normalize each allowed origin to its canonical string form (strips
  // exposure.allowedOrigins is already canonicalized by
  // server-mode-exposure.ts via origin-pattern.ts (which — unlike
  // `new URL(o).origin` — handles wildcard entries instead of silently
  // treating '*' as a literal hostname character). No re-normalization here.
  const normalizedOrigins = exposure.allowedOrigins

  return {
    ok: true,
    kind: 'server-mode',
    publicBaseUrl: exposure.publicBaseUrl,
    allowedOrigins: normalizedOrigins,
    trustedProxy: exposure.trustedProxy,
    pnaHeader: 'disabled',
    routeAuthPlan: SERVER_MODE_ROUTE_AUTH_PLAN.map(({ group, requiredScopes }) => ({
      group,
      requiredScopes: [...requiredScopes],
    })),
  }
}
