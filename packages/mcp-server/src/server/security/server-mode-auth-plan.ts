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
//   This layer normalizes each accepted origin via new URL(o).origin before
//   placing it in the decision. This strips default ports (https :443, http :80)
//   so stored origins always match the scheme+host+port format that browsers
//   send in the Origin request header.
//
// Failure contract:
//   All failure decisions are code-only — no raw URL, credential, path, stack
//   frame, or token appears in the output. Failure codes are delegated from
//   server-mode-exposure.ts and are stable literal values.

import type { AuthScope } from './auth-strategy.js'
import {
  type ServerModeExposureFailureCode,
  type ServerModeExposureInput,
  resolveServerModeExposure,
} from './server-mode-exposure.js'

// Stable identifiers for logical route groups that will be scope-gated.
// Each group maps to exactly one required AuthScope in SERVER_MODE_ROUTE_AUTH_PLAN,
// so callers can check a single scope per resource rather than an AND-combination.
export type RouteGroupId =
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

export interface RouteGroupAuthPlan {
  readonly group: RouteGroupId
  readonly requiredScopes: readonly AuthScope[]
}

// PNA (Private Network Access) header policy:
//   'loopback'  — local-daemon must respond to PNA preflight from browser pages
//                 that access the loopback interface.
//   'disabled'  — server-mode runs on a proper HTTPS origin; no PNA header needed.
export type PnaHeaderPolicy = 'loopback' | 'disabled'

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
  { group: 'canvas-read',    requiredScopes: ['canvas:read'] },
  { group: 'workspace-read', requiredScopes: ['workspace:read'] },
  { group: 'versions-read',  requiredScopes: ['versions:read'] },
  { group: 'files-read',     requiredScopes: ['files:read'] },
  { group: 'canvas-write',   requiredScopes: ['canvas:write'] },
  { group: 'workspace-write',requiredScopes: ['workspace:write'] },
  { group: 'versions-write', requiredScopes: ['versions:write'] },
  { group: 'files-write',    requiredScopes: ['files:write'] },
  { group: 'runtime-read',   requiredScopes: ['runtime:read'] },
  { group: 'runtime-admin',  requiredScopes: ['runtime:admin'] },
  { group: 'mcp',            requiredScopes: ['mcp:call'] },
]

export function planServerModeAuth(
  input: ServerModeExposureInput,
): ServerModeAuthPlanDecision {
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

  // Normalize each allowed origin to URL.origin (strips default ports,
  // ensures consistent comparison with the Origin header browsers send).
  const normalizedOrigins = exposure.allowedOrigins.map((o) => new URL(o).origin)

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
