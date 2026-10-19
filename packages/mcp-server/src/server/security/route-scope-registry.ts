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
// deliberately unauthenticated routes (`GET /api/runtime/ping`, a liveness
// probe, and `GET /api/runtime/proof`, a daemon's proof that it holds its
// token) read as a decision instead of an accidental gap.
//
// `route-scope-registry.test.ts` walks every route actually mounted on the
// server-mode Hono app (`app.routes`) and asserts each one resolves to a
// non-null decision here — the same "registry vs what's actually registered"
// guard shape as the MCP smoke's `tools/list` vs `ALL_REGISTERED_TOOLS`
// (`mcp/mcp-smoke-coverage.ts`).

import { DOCUMENT_API_ACTIONS } from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import type { AuthScope } from './auth-strategy.js'

export type RouteScopeDecision =
  | { kind: 'scoped'; scopes: readonly AuthScope[] }
  | { kind: 'public' }
  // Judged by the credential's KIND, never its scopes: only full authority
  // (the daemon token, or an open daemon) reaches the route, and server mode,
  // having no daemon token, refuses it outright. For a route no scope set
  // should open however wide it is — `/api/debug`'s dump of every live
  // document today, and any route that hands out daemon-level authority, where
  // a scope-limited grant reaching it could mint a path back to the full,
  // unscoped token and escape the scopes it was approved for.
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
   * Which WORKSPACE this route reaches, for the membership gate
   * (`workspace-access.ts`). Absent means the route is not gated on
   * membership at all: runtime/debug/etc; the local daemon's `workspace
   * replica-key` routes, which serve its one person; and `workspace
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

const DOCUMENT_FILE = /^\/api\/w\/[^/]+\/document\/.+\/file\/[^/]+$/
const DOCUMENT_ACTIONS: ReadonlySet<string> = new Set(DOCUMENT_API_ACTIONS)

// `/?$`: the router strips one trailing slash before it reads the suffix.
const DOCUMENT_VERSIONS_READ =
  /^\/api\/workspaces\/[^/]+\/documents\/.+\/versions(?:\/[^/]+\/document)?\/?$/
const DOCUMENT_VERSIONS_WRITE =
  /^\/api\/workspaces\/[^/]+\/documents\/.+\/versions(?:\/[^/]+\/restore)?\/?$/

const always =
  (...scopes: readonly AuthScope[]) =>
  (): RouteScopeDecision => ({ kind: 'scoped', scopes })
const byAccess =
  (write: AuthScope, read: AuthScope) =>
  (isWrite: boolean): RouteScopeDecision => ({ kind: 'scoped', scopes: [isWrite ? write : read] })
const publicRoute = (): RouteScopeDecision => ({ kind: 'public' })

const API_ROUTE_RULES: readonly RouteScopeRule[] = [
  // A public route: a liveness probe that identifies the responder
  // (instanceId, advertised public key) and carries no secret or document
  // data, so it must answer a caller that holds no credential yet. Every
  // other /api/runtime/* path requires a scope below.
  { name: 'runtime/ping', claims: exactly('/api/runtime/ping'), decide: publicRoute },
  // A daemon's proof that it holds its token, asked by a client that will not
  // send the token until it has one (shared/endpoint-proof.ts) — so it must
  // answer a caller holding no credential, and it carries no secret.
  { name: 'runtime/proof', claims: exactly('/api/runtime/proof'), decide: publicRoute },

  // A file whose id is spelled like a document action (`…/a/file/update`) is
  // also that action on the document `a/file`, and which of the two answers
  // is decided by which router is mounted first. It asks for both, so neither
  // a files grant nor a canvas grant reaches the other's half alone.
  {
    name: 'document file/action overlap',
    claims: (path) =>
      DOCUMENT_FILE.test(path) && DOCUMENT_ACTIONS.has(path.slice(path.lastIndexOf('/') + 1)),
    decide: (isWrite) => ({
      kind: 'scoped',
      scopes: isWrite ? ['files:write', 'canvas:write'] : ['files:read', 'canvas:read'],
    }),
    workspace: wHandle,
  },

  // File routes: reading/writing a document's attached binary file. The
  // document path is multi-segment, so the discriminator is the mandatory
  // `/file/<fileId>` suffix — the same suffix-anchored parse the router uses.
  {
    name: 'document file',
    claims: matching(DOCUMENT_FILE),
    decide: byAccess('files:write', 'files:read'),
    workspace: wHandle,
  },

  // The workspace-document sync surface: one snapshot/update pair for the
  // whole workspace document. Same tier as the per-document equivalents —
  // a workspace-granularity update is still a document mutation, just scoped
  // wider, and the snapshot answers the same content canvas:read grants.
  // An update that adds, removes or moves a document needs workspace:write as
  // well, which is judged of the update itself rather than here: the gate sees
  // a path, and only the operations say what kind of change they make
  // (`DocumentRouterOptions.mayPlaceDocuments`). The per-document update's
  // lazy create below is judged the same way.
  // Promotion merges a whole record in — documents, content AND explicit
  // checkpoints (ADR-0039) — so it needs what each of those needs.
  {
    name: 'workspace-document/promote',
    claims: matching(/^\/api\/w\/[^/]+\/workspace-document\/promote$/, 'POST'),
    decide: always('canvas:write', 'workspace:write', 'versions:write'),
    workspace: wHandle,
  },
  {
    name: 'workspace-document sync',
    claims: matching(/^\/api\/w\/[^/]+\/workspace-document\/(snapshot|update)$/),
    decide: byAccess('canvas:write', 'canvas:read'),
    workspace: wHandle,
  },

  // Document write operations that arrive as POST but mutate state.
  {
    name: 'document update/export',
    claims: matching(/^\/api\/w\/[^/]+\/document\/.+\/(update|export)$/, 'POST'),
    decide: always('canvas:write'),
    workspace: wHandle,
  },
  // Remaining /api/w/:workspaceId/document/* routes: honor the write/read
  // split so a mutating POST isn't authorized by
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
  // read-only grant able to fetch a document but never observe it change.
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

  // Version history and restore — version-control operations scoped to a
  // single document. The router reads these as a suffix matched from the END
  // of a document path of any depth (`matchDocumentsTail`), and with its verb:
  // the same tail under another verb is a document operation, e.g. DELETE
  // `…/documents/a/versions` deletes the document `a/versions`. Read from the
  // front, a nested document's history would fall to the workspace rule and a
  // document merely spelled `versions…` would answer to a versions grant.
  // HEAD is Hono's GET with the body dropped, so it is read the same way.
  {
    name: 'document versions',
    claims: (path, method) =>
      method === 'GET' || method === 'HEAD'
        ? DOCUMENT_VERSIONS_READ.test(path)
        : method === 'POST' && DOCUMENT_VERSIONS_WRITE.test(path),
    decide: byAccess('versions:write', 'versions:read'),
    workspace: workspacesHandle,
  },

  {
    name: 'versions/prune-sandwiched',
    claims: matching(/^\/api\/workspaces\/[^/]+\/versions\/prune-sandwiched$/),
    // Only a POST is mounted; a read verb is read-level like every other
    // rule's, so no GET is ever guarded as though it changed something.
    decide: byAccess('versions:write', 'versions:read'),
    workspace: workspacesHandle,
  },

  // Destructive maintenance routes mounted under /api/workspaces need their
  // own narrower scope — without this rule they'd fall through to the
  // workspace:write fallback below, which is broader than what they
  // actually mutate (attachment blobs / document version history) and would
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

  // The read plane's workspace content key (ADR-0042 decisions 1/3/5). The
  // key confers READ, so workspace:read is the bar here rather than the
  // catch-all's write-by-default answer below.
  {
    name: 'workspace replica-key',
    claims: matching(/^\/api\/workspaces\/[^/]+\/replica-key$/, 'POST'),
    decide: always('workspace:read'),
  },

  // Rotation (ADR-0042 decision 1, 2026-09-21 addendum): replaces the
  // workspace's key+salt outright, denying every document key derived from
  // the OLD pair and every browser replica sealed under it — at least as
  // consequential as the tier change below, so it sits at the same admin
  // bar rather than the plain key route's workspace:read. Its place below
  // `workspace replica-key` is not load-bearing: the plain route's pattern is
  // `$`-anchored and does not match a `/rotate` suffix, so neither rule can
  // shadow the other in either order — pinned by `CLAIMED_BY` in the test
  // rather than assumed.
  {
    name: 'workspace replica-key rotate',
    claims: matching(/^\/api\/workspaces\/[^/]+\/replica-key\/rotate$/, 'POST'),
    decide: always('runtime:admin'),
  },

  // The tier itself (ADR-0042 decision 1 addendum, 2026-09-21): a security-
  // posture change about whether a copy of this workspace may leave the
  // daemon at all, so it sits at the admin bar — an operator decision, not
  // the workspace:write below
  // that any member's write-scoped grant already carries. Placed above
  // `workspaces (rest)` so first-match-wins cannot let a PUT on this path
  // fall through to that broader, weaker scope.
  {
    name: 'workspace replica-tier',
    claims: matching(/^\/api\/workspaces\/[^/]+\/replica-tier$/, 'PUT'),
    decide: always('runtime:admin'),
  },

  // The /api/v1 routes that answer with, or rewrite, what documents SAY: the
  // OKF projection, ranked hits with excerpts, backlinks with context, the
  // tags documents carry beside the tag and stencil libraries, and the
  // linkify rewrite of a body. Content is the canvas scopes' on every other
  // surface — the snapshot route, wb_document_get, wb_document_search — so
  // workspace:read, which lists and resolves documents, must not read it here.
  // Above 'workspaces (rest)', which would otherwise claim them first.
  {
    name: 'v1 document content',
    claims: matching(
      /^\/api\/v1\/workspaces\/[^/]+\/(?:search|document-tags|documents\/[^/]+\/(?:okf|backlinks|linkify-mentions))$/,
    ),
    decide: byAccess('canvas:write', 'canvas:read'),
    workspace: workspacesHandle,
  },

  // A workspace's people and its invitation links (ADR-0049), mounted on
  // server mode only. The scope is the workspace one, as below; what a change
  // needs beyond it is an OWNER acting through a browser SIGN-IN, which the
  // router asks per request (`people-keepers.ts`) because no scope says it —
  // so a bearer scoped `workspace:write` reaches the route and is refused
  // there, as tenant administration refuses one. A segment change has the
  // same bar, but is the workspace's own PATCH and decided by its body, so
  // `workspaces (rest)` keeps it.
  {
    name: 'workspace people',
    claims: matching(/^\/api\/workspaces\/[^/]+\/(?:people|invitations)(?:\/[^/]+)?\/?$/),
    decide: byAccess('workspace:write', 'workspace:read'),
    workspace: workspacesHandle,
  },

  // Workspace routes: default write -> workspace:write, read -> workspace:read.
  //
  // The rest of the /api/v1 document surface (server-core's createServer,
  // mounted when the daemon is given ServerDeps) — listing, resolving,
  // creating and deleting documents — takes the SAME decision deliberately,
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

  // A tenant's people and its invitations to the tenant alone (ADR-0049),
  // mounted on server mode only. The router answers only an ADMINISTRATOR,
  // a role a person holds rather than a scope a credential carries, so the
  // scope here says no more than that the credential acts for a person: the
  // same bar a person's own workspaces sit at. No workspace is addressed, so
  // there is nothing for the membership gate to judge.
  {
    name: 'tenant people',
    claims: (path) =>
      path === '/api/people' || path.startsWith('/api/people/') || path === '/api/invitations',
    decide: byAccess('workspace:write', 'workspace:read'),
  },

  { name: 'runtime (rest)', claims: under('/api/runtime/'), decide: always('runtime:read') },

  { name: 'debug', claims: under('/api/debug'), decide: () => ({ kind: 'daemon-token-only' }) },

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
]

/** The rules, for the walk that proves none of them is shadowed. */
export const API_ROUTE_RULE_NAMES: readonly string[] = API_ROUTE_RULES.map((rule) => rule.name)

/** The names of the rules declaring a `workspace` extractor — the
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
 * What a restore needs beyond the `versions:write` its route and tool are
 * registered under. In place it rewrites the one document whose history it
 * reads, which is a history operation. Into another path it creates or
 * replaces that document, and as a subtree it reverts, resurrects and deletes
 * descendants — document writes, so they need `workspace:write`, the scope
 * creating, replacing and deleting documents takes everywhere else.
 *
 * The body names the mode, and a route's scope is decided from its path and
 * verb before any body is read, so each surface asks this once the request
 * is parsed. `path` is the document's, where the surface knows it: a target
 * equal to it is the in-place restore. A surface that does not know it treats
 * any target as another document.
 */
export function restoreScopes(
  asked: { readonly targetPath?: unknown; readonly subtree?: unknown },
  path?: string,
): readonly AuthScope[] {
  const elsewhere = typeof asked.targetPath === 'string' && asked.targetPath !== path
  return elsewhere || asked.subtree === true
    ? ['versions:write', 'workspace:write']
    : ['versions:write']
}

/**
 * What a document create needs beyond the `workspace:write` that places a
 * document: a create carrying a markdown body writes content, which is
 * `canvas:write` on every other surface — the per-document update, the body
 * edit, the linkify rewrite. A create with no body, or a spatial one, writes
 * none. Judged after the body is parsed, as `restoreScopes` is.
 */
export function createBodyScopes(asked: { readonly markdown?: unknown }): readonly AuthScope[] {
  return carriesBody(asked) ? ['workspace:write', 'canvas:write'] : ['workspace:write']
}

/** Whether a create request names a markdown body with something in it. */
export function carriesBody(asked: { readonly markdown?: unknown }): boolean {
  return typeof asked.markdown === 'string' && asked.markdown.length > 0
}

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
