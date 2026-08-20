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
  // Reserved for a route whose whole purpose is to hand out daemon-level
  // authority: a scope-limited hosted-origin grant that could reach such a
  // route would let itself mint a path back to the full, unscoped daemon
  // token, escaping the very scopes it was approved for. No route currently
  // produces this decision (the silent-reconnect surface that introduced it
  // was removed), but it is kept as defense-in-depth for a future
  // daemon-authority route rather than deleted.
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

  // Same carve-out class as ping: the identity challenge (POST-only) must be
  // answerable BEFORE any pairing exists — it is how a browser decides
  // whether a responder is trustworthy at all. Rate-limited in the router.
  if (path === '/api/runtime/verify') return { kind: 'public' }

  const isWrite = isWriteMethod(method)

  // File routes: reading/writing a canvas's attached binary file. The
  // document path is multi-segment, so the discriminator is the mandatory
  // `/file/<fileId>` suffix — the same suffix-anchored parse the router uses.
  if (/^\/api\/w\/[^/]+\/document\/.+\/file\/[^/]+$/.test(path)) {
    return { kind: 'scoped', scopes: [isWrite ? 'files:write' : 'files:read'] }
  }

  // Canvas write operations that arrive as POST but mutate state.
  if (/^\/api\/w\/[^/]+\/document\/.+\/(update|export)$/.test(path) && method === 'POST') {
    return { kind: 'scoped', scopes: ['canvas:write'] }
  }
  // Remaining /api/w/:workspaceId/document/* routes: honor the write/read
  // split so a mutating POST (e.g. /viewport) isn't authorized by
  // canvas:read alone. The specific write routes above still take
  // precedence via ordering.
  if (/^\/api\/w\/[^/]+\/document\//.test(path)) {
    return { kind: 'scoped', scopes: [isWrite ? 'canvas:write' : 'canvas:read'] }
  }

  // SSE sync transport. These are canvas:read even though two of them are
  // POSTs: they mutate only which documents this stream is told about, and
  // receiving a document's updates is exactly the access canvas:read already
  // grants. Scoping them to canvas:write by the method rule would leave a
  // read-only grant able to fetch a canvas but never observe it change.
  //
  // Matched exactly rather than by prefix: that rationale covers these three
  // routes, and a later mutating route under the same prefix would otherwise
  // inherit read-level authorization silently instead of falling through to
  // the fail-closed default.
  if (
    path === '/api/sync/stream' ||
    path === '/api/sync/subscribe' ||
    path === '/api/sync/message'
  ) {
    return { kind: 'scoped', scopes: ['canvas:read'] }
  }

  // Version history, thumbnails, restore, compact — version-control
  // operations scoped to a single canvas.
  if (
    /^\/api\/workspaces\/[^/]+\/documents\/[^/]+\/(versions|latest-thumbnail|compact)/.test(path)
  ) {
    return { kind: 'scoped', scopes: [isWrite ? 'versions:write' : 'versions:read'] }
  }

  // Branch and checkpoint routes — version-control operations at the
  // workspace level.
  if (/^\/api\/workspaces\/[^/]+\/documents\/[^/]+\/branches/.test(path)) {
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
  if (/^\/api\/workspaces\/[^/]+\/documents\/optimize-all$/.test(path) && method === 'POST') {
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

  // Fonts (ADR-0012). Installing one makes the daemon issue an outbound
  // request and write to its own data directory, changing what every later
  // export renders — daemon-level configuration, so it sits at the same admin
  // tier as the other routes that mutate daemon state, not at canvas:write.
  // Reading the catalogue is harmless and answers a picker.
  if (path === '/api/fonts' || path.startsWith('/api/fonts/')) {
    return { kind: 'scoped', scopes: [isWrite ? 'runtime:admin' : 'runtime:read'] }
  }

  // POST /api/ws-ticket (ADR-0005): mints a WS connection ticket bound to
  // the caller's own OAuth grant scopes. canvas:read is the floor any live
  // grant is assumed to hold — the minted ticket never carries more than
  // the presented grant's own scopes regardless of this route's own
  // requirement, so this is a "can you ask at all" gate, not an escalation.
  if (path === '/api/ws-ticket') {
    return { kind: 'scoped', scopes: ['canvas:read'] }
  }

  // POST /api/pairing/token — the pairing-grant flow's deliberately PUBLIC
  // endpoint (the second of exactly two public routes, with /api/runtime/
  // ping): it authenticates by other means — a single-use PKCE-bound code,
  // or the browser-enforced Origin header matched against a persisted
  // grant — and it must be reachable by an origin that does not hold a
  // bearer yet. Guard enumeration lives in routes/pairing.ts.
  if (path === '/api/pairing/token') {
    return { kind: 'public' }
  }
  // Persisting a grant is a consent decision made on the daemon's own
  // served UI (which carries the daemon token); nothing below admin may
  // widen the origin allowlist. Listing and revoking grants (the
  // management surface, including DELETE /api/pairing/grants/:grantId)
  // sit behind the same bar.
  if (path === '/api/pairing/grants' || path.startsWith('/api/pairing/grants/')) {
    return { kind: 'scoped', scopes: ['runtime:admin'] }
  }

  // No rule matched: an undeclared /api/* route. Callers must fail closed.
  return null
}
