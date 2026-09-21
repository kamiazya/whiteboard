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
// guard shape as the MCP smoke's `tools/list` vs `ALL_REGISTERED_TOOLS`
// (`mcp/mcp-smoke-coverage.ts`).

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

/**
 * One rule of the policy: what it CLAIMS, and what it then decides.
 *
 * The table below is ordered and FIRST MATCH WINS, which is the whole of the
 * policy's control flow — so a rule placed under a broader one is dead, and
 * `route-scope-registry.test.ts` walks the table to say so. `name` exists for
 * that walk: it is what a shadowed rule is reported by.
 *
 * `decide` takes the write/read split rather than the method, because that is
 * the only thing about a request any decision here turns on beyond the path;
 * a rule that needs the method itself says so in `claims`.
 */
interface RouteScopeRule {
  readonly name: string
  readonly claims: (path: string, method: string) => boolean
  readonly decide: (isWrite: boolean) => RouteScopeDecision
  /**
   * S8: which WORKSPACE this route reaches, for the membership gate
   * (`workspace-access.ts`). Absent means origin-trusted — the route is not
   * gated on membership at all: pairing/runtime/debug/etc; `workspace
   * members` and `workspace replica-key`, which decide membership
   * themselves at a finer grain than this table can see; and `workspace
   * replica-tier`, an operator decision with no membership concept at all
   * (the bar IS the whole gate — see routes/replica-key.ts's header).
   *
   * Return `undefined` when this request has no handle segment at all
   * (legitimately ungated, e.g. the bare workspaces collection), and `null`
   * when a handle segment is present but failed to decode — the caller
   * (`gatedWorkspaceHandle`) turns that into a distinct fail-closed signal
   * rather than treating it the same as "not gated".
   */
  readonly workspace?: (path: string) => string | null | undefined
}

const exactly =
  (...paths: readonly string[]) =>
  (path: string): boolean =>
    paths.includes(path)
const matching =
  (pattern: RegExp, method?: string) =>
  (path: string, m: string): boolean =>
    pattern.test(path) && (method === undefined || m === method)
const under =
  (...prefixes: readonly string[]) =>
  (path: string): boolean =>
    prefixes.some((prefix) => path.startsWith(prefix))

// `undefined`: no capturing group matched this path at all (the rule
// declares an extractor but this particular request has no handle segment,
// e.g. the bare workspaces collection) — legitimately not gated.
// `null`: a handle segment was present but failed strict decoding (e.g.
// invalid percent-encoding) — the route IS gated and the handle is simply
// unreadable, which must fail closed rather than read the same as
// "no handle" (see `gatedWorkspaceHandle`).
function decodeHandle(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

// The /api/w/:handle/... family (document file, workspace-document,
// document update/export, document (rest)).
const wHandlePattern = /^\/api\/w\/([^/]+)\//
const wHandle = (path: string): string | null | undefined =>
  decodeHandle(wHandlePattern.exec(path)?.[1])

// The /api/(v1/)?workspaces/:handle(/...|$) family. Also yields the handle
// for /api/workspaces/:id itself (summary/rename/delete) — a non-member
// renaming or deleting a member-gated workspace is a write, so it is gated
// too; only the bare collection GET|POST /api/workspaces is exempt (no
// capturing group matches there).
const workspacesHandlePattern = /^\/api\/(?:v1\/)?workspaces\/([^/]+)(?:\/|$)/
const workspacesHandle = (path: string): string | null | undefined =>
  decodeHandle(workspacesHandlePattern.exec(path)?.[1])

const always =
  (...scopes: readonly AuthScope[]) =>
  (): RouteScopeDecision => ({ kind: 'scoped', scopes })
const byAccess =
  (write: AuthScope, read: AuthScope) =>
  (isWrite: boolean): RouteScopeDecision => ({ kind: 'scoped', scopes: [isWrite ? write : read] })
const publicRoute = (): RouteScopeDecision => ({ kind: 'public' })

const API_ROUTE_RULES: readonly RouteScopeRule[] = [
  // Deliberate, documented carve-out: an unauthenticated liveness probe used
  // by daemon-discovery and the mixed-content preflight (ADR-0002). Every
  // other /api/runtime/* path requires a scope below.
  { name: 'runtime/ping', claims: exactly('/api/runtime/ping'), decide: publicRoute },

  // Same carve-out class as ping: the identity challenge (POST-only) must be
  // answerable BEFORE any pairing exists — it is how a browser decides
  // whether a responder is trustworthy at all. Rate-limited in the router.
  { name: 'runtime/verify', claims: exactly('/api/runtime/verify'), decide: publicRoute },

  // File routes: reading/writing a canvas's attached binary file. The
  // document path is multi-segment, so the discriminator is the mandatory
  // `/file/<fileId>` suffix — the same suffix-anchored parse the router uses.
  {
    name: 'document file',
    claims: matching(/^\/api\/w\/[^/]+\/document\/.+\/file\/[^/]+$/),
    decide: byAccess('files:write', 'files:read'),
    workspace: wHandle,
  },

  // The workspace-document sync surface: one snapshot/update pair for the
  // whole workspace document. Same tier as the per-document equivalents —
  // a workspace-granularity update is still a canvas mutation, just scoped
  // wider, and the snapshot answers the same content canvas:read grants.
  // Promotion merges the record AND writes explicit checkpoints for it
  // (ADR-0039), so it needs what both of those need.
  {
    name: 'workspace-document/promote',
    claims: matching(/^\/api\/w\/[^/]+\/workspace-document\/promote$/, 'POST'),
    decide: always('canvas:write', 'versions:write'),
    workspace: wHandle,
  },
  {
    name: 'workspace-document sync',
    claims: matching(/^\/api\/w\/[^/]+\/workspace-document\/(snapshot|update)$/),
    decide: byAccess('canvas:write', 'canvas:read'),
    workspace: wHandle,
  },

  // Canvas write operations that arrive as POST but mutate state.
  {
    name: 'document update/export',
    claims: matching(/^\/api\/w\/[^/]+\/document\/.+\/(update|export)$/, 'POST'),
    decide: always('canvas:write'),
    workspace: wHandle,
  },
  // Remaining /api/w/:workspaceId/document/* routes: honor the write/read
  // split so a mutating POST (e.g. /viewport) isn't authorized by
  // canvas:read alone. The specific write routes above still take
  // precedence via ordering.
  {
    name: 'document (rest)',
    claims: matching(/^\/api\/w\/[^/]+\/document\//),
    decide: byAccess('canvas:write', 'canvas:read'),
    workspace: wHandle,
  },

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
  {
    name: 'sync transport',
    claims: exactly('/api/sync/stream', '/api/sync/subscribe', '/api/sync/message'),
    decide: always('canvas:read'),
  },

  // Version history, restore, compact — version-control operations scoped
  // to a single canvas.
  {
    name: 'document versions/compact',
    claims: matching(/^\/api\/workspaces\/[^/]+\/documents\/[^/]+\/(versions|compact)/),
    decide: byAccess('versions:write', 'versions:read'),
    workspace: workspacesHandle,
  },

  // Branch and checkpoint routes — version-control operations at the
  // workspace level.
  {
    name: 'document branches',
    claims: matching(/^\/api\/workspaces\/[^/]+\/documents\/[^/]+\/branches/),
    decide: byAccess('versions:write', 'versions:read'),
    workspace: workspacesHandle,
  },
  {
    name: 'workspace checkpoints',
    claims: matching(/^\/api\/workspaces\/[^/]+\/checkpoints$/),
    decide: always('versions:write'),
    workspace: workspacesHandle,
  },
  {
    name: 'versions/prune-sandwiched',
    claims: matching(/^\/api\/workspaces\/[^/]+\/versions\/prune-sandwiched$/),
    decide: always('versions:write'),
    workspace: workspacesHandle,
  },

  // Destructive maintenance routes mounted under /api/workspaces need their
  // own narrower scope — without this rule they'd fall through to the
  // workspace:write fallback below, which is broader than what they
  // actually mutate (attachment blobs / canvas version history) and would
  // let any workspace:write grant trigger them.
  {
    name: 'files/purge-dangling',
    claims: matching(/^\/api\/workspaces\/[^/]+\/files\/purge-dangling$/, 'POST'),
    decide: always('files:write'),
    workspace: workspacesHandle,
  },
  {
    name: 'documents/optimize-all',
    claims: matching(/^\/api\/workspaces\/[^/]+\/documents\/optimize-all$/, 'POST'),
    decide: always('versions:write'),
    workspace: workspacesHandle,
  },

  // Membership (ADR-0041/0042): who has L1 access to a workspace. Same bar
  // as pairing-grant and credential-pin management — a paired browser
  // session that can manage grants and passkey pins can manage members too
  // (accepted v1 posture; narrowing what a pairing session may do is its
  // own future increment, per routes/membership.ts's header).
  {
    name: 'workspace members',
    claims: matching(/^\/api\/workspaces\/[^/]+\/members(\/[^/]+)?$/),
    decide: always('runtime:admin'),
  },

  // The read plane's workspace content key (ADR-0042 decisions 1/3/5). The
  // key confers READ, so workspace:read is the bar here rather than the
  // catch-all's write-by-default answer below — a grant lacking the
  // required passkey binding is refused by the handler itself regardless of
  // scope.
  {
    name: 'workspace replica-key',
    claims: matching(/^\/api\/workspaces\/[^/]+\/replica-key$/, 'POST'),
    decide: always('workspace:read'),
  },

  // The tier itself (ADR-0042 decision 1 addendum, 2026-09-21): a security-
  // posture change about whether a copy of this workspace may leave the
  // daemon at all, so it sits at the same admin bar as membership and grant
  // management above — an operator decision, not the workspace:write below
  // that any member's write-scoped grant already carries. Placed above
  // `workspaces (rest)` so first-match-wins cannot let a PUT on this path
  // fall through to that broader, weaker scope.
  {
    name: 'workspace replica-tier',
    claims: matching(/^\/api\/workspaces\/[^/]+\/replica-tier$/, 'PUT'),
    decide: always('runtime:admin'),
  },

  // Workspace routes: default write -> workspace:write, read -> workspace:read.
  //
  // The /api/v1 document surface (server-core's createServer, mounted when
  // the daemon is given ServerDeps) takes the SAME decision deliberately,
  // because what differs between the two is how a document is ADDRESSED — by
  // path there, by the id the index assigned here — not what a caller may do
  // to it. Splitting them would mean one grant that reaches a document by id
  // and a different one that reaches the same document by path.
  //
  // The v1 prefix is spelled out rather than folded into the other:
  // `startsWith('/api/workspaces')` does not match `/api/v1/workspaces`, so
  // before it existed every v1 path resolved to null. That is fail-closed
  // (server-mode answers 500 auth.route-undeclared), so nothing was ever
  // under-protected — but it made the surface unusable in server mode for a
  // reason no one had decided, and the registry-wide guard could not see it
  // because the apps it walked were built without ServerDeps.
  {
    name: 'workspaces (rest)',
    claims: under('/api/workspaces', '/api/v1/workspaces'),
    decide: byAccess('workspace:write', 'workspace:read'),
    workspace: workspacesHandle,
  },

  // Deleting the daemon's own log files mutates state no other runtime route
  // touches, so it requires the admin tier even though its HTTP verb is POST
  // like any other write route. Stopping the process is deliberately NOT here:
  // it is a signal, not a route.
  {
    name: 'runtime/logs/prune',
    claims: exactly('/api/runtime/logs/prune'),
    decide: always('runtime:admin'),
  },
  { name: 'runtime (rest)', claims: under('/api/runtime/'), decide: always('runtime:read') },

  { name: 'debug', claims: under('/api/debug'), decide: always('runtime:admin') },

  // Fonts (ADR-0012). Installing one makes the daemon issue an outbound
  // request and write to its own data directory, changing what every later
  // export renders — daemon-level configuration, so it sits at the same admin
  // tier as the other routes that mutate daemon state, not at canvas:write.
  // Reading the catalogue is harmless and answers a picker.
  {
    name: 'fonts',
    claims: (path) => path === '/api/fonts' || path.startsWith('/api/fonts/'),
    decide: byAccess('runtime:admin', 'runtime:read'),
  },

  // POST /api/ws-ticket (ADR-0005): mints a WS connection ticket bound to
  // the caller's own OAuth grant scopes. canvas:read is the floor any live
  // grant is assumed to hold — the minted ticket never carries more than
  // the presented grant's own scopes regardless of this route's own
  // requirement, so this is a "can you ask at all" gate, not an escalation.
  { name: 'ws-ticket', claims: exactly('/api/ws-ticket'), decide: always('canvas:read') },

  // POST /api/pairing/token — the pairing-grant flow's deliberately PUBLIC
  // endpoint (the third of exactly three public routes, with
  // /api/runtime/ping and /api/runtime/verify): it authenticates by other
  // means — a single-use PKCE-bound code, or the browser-enforced Origin
  // header matched against a persisted grant — and it must be reachable by
  // an origin that does not hold a bearer yet. Guard enumeration lives in
  // routes/pairing.ts.
  { name: 'pairing/token', claims: exactly('/api/pairing/token'), decide: publicRoute },

  // Persisting a grant is a consent decision made on the daemon's own
  // served UI (which carries the daemon token); nothing below admin may
  // widen the origin allowlist. Listing and revoking grants (the
  // management surface, including DELETE /api/pairing/grants/:grantId)
  // sit behind the same bar.
  //
  // Credential pins (ADR-0039) sit at the same bar: a pin is what an
  // attestation is verified against, so planting or revoking one is the
  // consent surface's, not a scoped OAuth client's. A paired origin's
  // session token reaches it the way it reaches grant management.
  {
    name: 'pairing grants and credentials',
    claims: (path) =>
      path === '/api/pairing/grants' ||
      path.startsWith('/api/pairing/grants/') ||
      path === '/api/pairing/credentials' ||
      path.startsWith('/api/pairing/credentials/'),
    decide: always('runtime:admin'),
  },

  // Session assertion (ADR-0041 S0-2): the scope check here only keeps a
  // narrower OAuth grant out. The real gate is the handler's own token-store
  // check (a valid pairing SESSION token for the requesting Origin) — an
  // open daemon's `anonymous` grant carries this scope too but has no
  // session to bind, and the handler refuses it with no bearer at all.
  {
    name: 'pairing/session-assert',
    claims: exactly('/api/pairing/session-assert', '/api/pairing/session-assert/challenge'),
    decide: always('runtime:admin'),
  },
]

/** The rules, for the walk that proves none of them is shadowed. */
export const API_ROUTE_RULE_NAMES: readonly string[] = API_ROUTE_RULES.map((rule) => rule.name)

/** The names of the rules declaring a `workspace` extractor — the S8
 *  membership-gate partition's other half (`route-scope-registry.test.ts`
 *  asserts this union with the origin-trusted list covers every rule name). */
export const GATED_RULE_NAMES: readonly string[] = API_ROUTE_RULES.filter(
  (rule) => rule.workspace !== undefined,
).map((rule) => rule.name)

/** Which rule claims this request, or `null` when none does. */
export function ruleClaiming(method: string, path: string): string | null {
  if (!path.startsWith('/api/')) return null
  return API_ROUTE_RULES.find((rule) => rule.claims(path, method))?.name ?? null
}

/** `gatedWorkspaceHandle`'s three outcomes:
 *  - `none`: no rule claims the path, the claiming rule is origin-trusted
 *    (declares no `workspace` extractor), or the rule declares one but this
 *    request has no handle segment (e.g. the bare workspaces collection).
 *    Not gated — the caller may proceed straight to `next()`.
 *  - `handle`: the workspace handle (segment or canonical id, unresolved)
 *    this request's route reaches.
 *  - `undecodable`: the claiming rule IS gated and a handle segment is
 *    present, but it failed strict decoding (e.g. invalid percent-encoding).
 *    The caller cannot determine which workspace this reaches, so it must
 *    refuse rather than silently skip the membership check — the same
 *    fail-closed posture `resolveApiRouteScope`'s `null` documents above.
 */
export type GatedWorkspaceHandle =
  | { readonly kind: 'none' }
  | { readonly kind: 'handle'; readonly handle: string }
  | { readonly kind: 'undecodable' }

/**
 * The workspace HANDLE this request's route reaches, for the membership
 * gate — the FIRST claiming rule's extractor, same first-match-wins order
 * as `resolveApiRouteScope`.
 */
export function gatedWorkspaceHandle(method: string, path: string): GatedWorkspaceHandle {
  if (!path.startsWith('/api/')) return { kind: 'none' }
  const rule = API_ROUTE_RULES.find((r) => r.claims(path, method))
  if (rule?.workspace === undefined) return { kind: 'none' }
  const handle = rule.workspace(path)
  if (handle === undefined) return { kind: 'none' }
  if (handle === null) return { kind: 'undecodable' }
  return { kind: 'handle', handle }
}

// Returns `null` when no rule above claims the path — the signal to fail
// closed (`auth.route-undeclared`) rather than silently authorizing with a
// guessed scope.
export function resolveApiRouteScope(method: string, path: string): RouteScopeDecision | null {
  if (!path.startsWith('/api/')) return null
  const rule = API_ROUTE_RULES.find((r) => r.claims(path, method))
  return rule === undefined ? null : rule.decide(isWriteMethod(method))
}
