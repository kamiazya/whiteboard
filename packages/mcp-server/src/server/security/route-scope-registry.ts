// Single declarative place for "what scope does this /api/* route need".
//
// Before this module, the mapping lived as a function
// (`resolveServerModeApiScopes` in app.ts) whose final branch was a
// catch-all: any path nobody had thought to special-case yet fell through to
// a default (`canvas:write` / `canvas:read`). That is exactly the shape ADR-
// 0005 calls out as the likely way scope enforcement ships broken — a route
// added later silently inherits a guess instead of a decision. This module
// replaces the catch-all with an explicit `null` ("nobody has declared this
// route yet") so the caller can fail closed, and a `public` decision so the
// one deliberately unauthenticated route (`GET /api/runtime/ping`, a
// liveness probe) reads as a decision instead of an accidental gap.
//
// `route-scope-registry.test.ts` walks every route actually mounted on the
// server-mode Hono app (`app.routes`) and asserts each one resolves to a
// non-null decision here — the same "registry vs what's actually registered"
// guard shape as `mcp/tool-registry-descriptions.test.ts`.

import type { AuthScope } from './auth-strategy.js'

export type RouteScopeDecision =
  | { kind: 'scoped'; scopes: readonly AuthScope[] }
  | { kind: 'public' }
  // Never satisfiable by an OAuth access token, regardless of its granted
  // scopes — only the literal shared daemon token authorizes this route.
  // Reserved for routes whose whole purpose is to hand out daemon-level
  // authority (see reconnect.ts): a scope-limited hosted-origin grant that
  // could reach this route would let itself mint a path back to the full,
  // unscoped daemon token, escaping the very scopes it was approved for.
  | { kind: 'daemon-token-only' }

function isWriteMethod(method: string): boolean {
  const normalized = method.toUpperCase()
  return (
    normalized === 'POST' ||
    normalized === 'PUT' ||
    normalized === 'PATCH' ||
    normalized === 'DELETE'
  )
}

// Returns `null` when no rule below claims the path — the signal to fail
// closed (`auth.route-undeclared`) rather than silently authorizing with a
// guessed scope.
export function resolveApiRouteScope(method: string, path: string): RouteScopeDecision | null {
  if (!path.startsWith('/api/')) return null

  // Deliberate, documented carve-out: an unauthenticated liveness probe used
  // by daemon-discovery and the mixed-content preflight (ADR-0002). Every
  // other /api/runtime/* path requires a scope below.
  if (path === '/api/runtime/ping') return { kind: 'public' }

  const isWrite = isWriteMethod(method)

  // File routes: reading/writing a canvas's attached binary file.
  if (/^\/api\/canvas\/[^/]+\/[^/]+\/file\//.test(path)) {
    return { kind: 'scoped', scopes: [isWrite ? 'files:write' : 'files:read'] }
  }

  // Canvas write operations that arrive as POST but mutate state.
  if (
    /^\/api\/canvas\/[^/]+\/[^/]+\/(update|export|export-json)$/.test(path) &&
    method === 'POST'
  ) {
    return { kind: 'scoped', scopes: ['canvas:write'] }
  }
  // Remaining /api/canvas/* routes: honor the write/read split so a mutating
  // POST (e.g. /viewport) isn't authorized by canvas:read alone. The
  // specific write routes above still take precedence via ordering.
  if (path.startsWith('/api/canvas/')) {
    return { kind: 'scoped', scopes: [isWrite ? 'canvas:write' : 'canvas:read'] }
  }

  // Version history, thumbnails, restore, compact — version-control
  // operations scoped to a single canvas.
  if (
    /^\/api\/workspaces\/[^/]+\/canvases\/[^/]+\/(versions|latest-thumbnail|compact)/.test(path)
  ) {
    return { kind: 'scoped', scopes: [isWrite ? 'versions:write' : 'versions:read'] }
  }

  // Branch and checkpoint routes — version-control operations at the
  // workspace level.
  if (/^\/api\/workspaces\/[^/]+\/canvases\/[^/]+\/branches/.test(path)) {
    return { kind: 'scoped', scopes: [isWrite ? 'versions:write' : 'versions:read'] }
  }
  if (/^\/api\/workspaces\/[^/]+\/checkpoints$/.test(path)) {
    return { kind: 'scoped', scopes: ['versions:write'] }
  }
  if (/^\/api\/workspaces\/[^/]+\/versions\/prune-sandwiched$/.test(path)) {
    return { kind: 'scoped', scopes: ['versions:write'] }
  }

  // Destructive maintenance routes mounted under /api/workspaces need their
  // own narrower scope — without this rule they'd fall through to the
  // workspace:write fallback below, which is broader than what they
  // actually mutate (attachment blobs / canvas version history) and would
  // let any workspace:write grant trigger them.
  if (/^\/api\/workspaces\/[^/]+\/files\/purge-dangling$/.test(path) && method === 'POST') {
    return { kind: 'scoped', scopes: ['files:write'] }
  }
  if (/^\/api\/workspaces\/[^/]+\/canvases\/optimize-all$/.test(path) && method === 'POST') {
    return { kind: 'scoped', scopes: ['versions:write'] }
  }

  // Workspace routes: default write -> workspace:write, read -> workspace:read.
  if (path.startsWith('/api/workspaces')) {
    return { kind: 'scoped', scopes: [isWrite ? 'workspace:write' : 'workspace:read'] }
  }

  // touch/shutdown/logs-prune all mutate daemon-managed process state
  // (liveness timer, process lifecycle, on-disk log files) and require the
  // admin tier even though the HTTP verb for prune is POST like any other
  // write route.
  if (
    path === '/api/runtime/touch' ||
    path === '/api/runtime/shutdown' ||
    path === '/api/runtime/logs/prune'
  ) {
    return { kind: 'scoped', scopes: ['runtime:admin'] }
  }
  if (path.startsWith('/api/runtime/')) {
    return { kind: 'scoped', scopes: ['runtime:read'] }
  }

  if (path.startsWith('/api/debug')) {
    return { kind: 'scoped', scopes: ['runtime:admin'] }
  }

  // POST /api/ws-ticket (ADR-0005): mints a WS connection ticket bound to
  // the caller's own OAuth grant scopes. canvas:read is the floor any live
  // grant is assumed to hold — the minted ticket never carries more than
  // the presented grant's own scopes regardless of this route's own
  // requirement, so this is a "can you ask at all" gate, not an escalation.
  if (path === '/api/ws-ticket') {
    return { kind: 'scoped', scopes: ['canvas:read'] }
  }

  // Silent-reconnect enrollment (see reconnect.ts): mints a reconnect secret
  // for the caller's own admitted Origin, which /api/reconnect-session later
  // exchanges for the full daemon token. `daemon-token-only`, not
  // `runtime:admin` — an OAuth grant scoped to `runtime:admin` (issued for
  // touch/shutdown/logs-prune/debug) must not be able to reach this route,
  // or it could use it as a one-way escalation to the unrestricted daemon
  // token the grant was never approved for.
  if (path === '/api/reconnect-credential') {
    return { kind: 'daemon-token-only' }
  }
  // Public like /api/reconnect-session below: minting a challenge nonce must
  // not itself require a daemon token (the caller no longer has one), and it
  // must mint regardless of whether the origin actually has an enrolled
  // credential — refusing based on enrollment status would make this route
  // an enrollment oracle. Origin admission is still enforced inside the
  // route; the challenge itself proves nothing without a subsequent valid
  // signature at /api/reconnect-session.
  if (path === '/api/reconnect-challenge') {
    return { kind: 'public' }
  }
  // The ONLY other deliberately public /api/* route besides the liveness
  // probe and the challenge mint above. Its purpose is to hand back a daemon
  // token to a caller that no longer has one, so it cannot itself require
  // that token. Its internal gates (reconnect.ts) are Origin admission +
  // credential possession (a valid challenge signature, or a legacy secret
  // during the grace period) + non-expired trust record — see
  // web-origin-trust-store.ts for why that combination does not weaken the
  // daemon-token boundary the way an Origin-only check would.
  if (path === '/api/reconnect-session') {
    return { kind: 'public' }
  }

  // No rule matched: an undeclared /api/* route. Callers must fail closed.
  return null
}
