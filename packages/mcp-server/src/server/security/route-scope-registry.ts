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
  if (path === '/api/import-migration-bundle') {
    return { kind: 'scoped', scopes: ['canvas:write'] }
  }
  // Remaining /api/canvas/* routes: honor the write/read split so a mutating
  // POST (e.g. /viewport) isn't authorized by canvas:read alone. The
  // specific write routes above still take precedence via ordering.
  if (path.startsWith('/api/canvas/')) {
    return { kind: 'scoped', scopes: [isWrite ? 'canvas:write' : 'canvas:read'] }
  }

  // User library routes are workspace-level shared state: a read is a
  // workspace read (not a canvas read — collapsing it onto canvas:read would
  // let a canvas-only grant enumerate the shared library), a write mutates it.
  if (path.startsWith('/api/user-libraries')) {
    return { kind: 'scoped', scopes: [isWrite ? 'workspace:write' : 'workspace:read'] }
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

  // Workspace routes (including palette and library sub-resources, which are
  // workspace-scoped state): default write -> workspace:write, read -> workspace:read.
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

  // No rule matched: an undeclared /api/* route. Callers must fail closed.
  return null
}
