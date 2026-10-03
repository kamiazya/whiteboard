import { ARCHITECTURE_MAP } from './architecture-map.data.js'
import type { BoundaryViolationKind } from './scanner.js'

// The per-package table lives in `architecture-map.data.ts` (so this file stays
// under its size budget); every consumer keeps importing it from here.
export { ARCHITECTURE_MAP } from './architecture-map.data.js'

/**
 * Cycles `cycle-check.ts`'s value-import graph detects today that are NOT
 * fixed yet. Each group is the SORTED list of file paths (relative to repo
 * root) in the strongly-connected component, matching `findImportCycles`'s
 * output shape exactly — that's what makes a path-keyed lookup viable.
 *
 * It is EMPTY, and `repo-coverage.test.ts` holds it there from both sides:
 * one assertion fails on a cycle that is not listed, the other on a listed
 * entry that is no longer a real cycle. So adding an entry is a deliberate
 * act with a test that will demand its removal once the debt is paid.
 *
 * A cycle closed by a call-time `await import()` rather than a static edge
 * both ways is NOT thereby safe. A dynamic import defers WHEN a module is
 * fetched, not whether the fetch can observe a module that is mid-evaluation
 * somewhere up the stack — and a module whose body has not run yet still has
 * its top-level bindings in TDZ, so the call fails with a bare
 * ReferenceError, intermittently and under load. An entry here is debt with
 * a known failure mode, never a cycle that has been reasoned safe.
 */
export const KNOWN_IMPORT_CYCLES: readonly (readonly string[])[] = []

/**
 * Strongly connected components of the import graph that exist ONLY through
 * `import type` edges — the half cycle-check.ts's value scan cannot see, and
 * the half a type-only edge hides precisely because it never fails at load.
 * Same shape as {@link KNOWN_IMPORT_CYCLES}, with one addition: each group
 * carries the reason it is still here, since there is no load-time failure to
 * argue for removing it.
 *
 * It is EMPTY. `repo-coverage.test.ts` pins it by equality from both sides, so
 * a new type cycle fails until it is fixed or listed with a reason, and a
 * listed group that stops being a component fails until it is deleted. The
 * key is the member set, so an entry cannot quietly absorb a knot that grew.
 * The usual fix is a leaf module owning the type both sides name, not an entry.
 */
export const KNOWN_TYPE_CYCLES: readonly {
  readonly members: readonly string[]
  readonly reason: string
}[] = []

/**
 * Cross-PACKAGE dependency cycles found and not yet dissolved — the
 * manifest-level companion to {@link KNOWN_IMPORT_CYCLES}, over
 * `dependencies` AND `devDependencies` (package-cycle-check.ts). Same
 * both-sides contract: a cycle not listed here fails the build, and an
 * entry whose cycle no longer exists fails it too.
 *
 * A listed cycle is not thereby safe at the SOURCE level: the manifest edge
 * only says the loop could be closed, and whatever keeps the closing import
 * type-only needs its own guard, named in the reason.
 */
/**
 * Package loops this repo accepts, with the reason each is not a defect.
 *
 * EMPTY, and that is the news: the one entry here was
 * canvas-render <-> plugin-visual, a loop closed only by every import back
 * being type-only — a property no manifest can see. The contract they shared
 * moved into `@kamiazya/whiteboard-scene`, below both, so the loop is gone
 * rather than tolerated. `renderer-independence.test.ts` in plugin-visual
 * now pins that there is no edge at all.
 */
export const KNOWN_PACKAGE_CYCLES: readonly {
  readonly packages: readonly string[]
  readonly reason: string
}[] = []

/**
 * Mechanics an ADAPTER still reaches directly, pending ADR-0018's migration.
 *
 * Each entry is one `<adapter file> -> <mechanic module>` edge, relative to
 * `packages/mcp-server/src/server`. An edge that is not here fails the build,
 * and an entry that is no longer a real edge fails it too, so an entry cannot
 * outlive the debt it names. Same shape, and the same reason, as
 * {@link KNOWN_IMPORT_CYCLES}.
 *
 * The rule could not land without it. Every one of these exists today, and
 * enforcing the invariant on an empty list would simply have failed the
 * build — so the debt is recorded rather than the guard postponed until
 * after the migration it is meant to verify.
 *
 * **Shrinking is what {@link ADAPTERS_REACHING_MECHANICS_CEILING} enforces,
 * and the two checks above do not.** They stop a fabricated entry and a stale
 * one; neither has anything to say about a real new edge added along with its
 * allowlist line, which is the ordinary way this list grows. Measured before
 * the ceiling existed: a genuine `routes/export.ts -> backup-in-progress`
 * import, duly listed, passed all six assertions. The list went 37 -> 36 ->
 * 35 -> 36 -> 40 over one week while both this doc comment and the test's own
 * comment said it could only shrink.
 */
export const ADAPTERS_REACHING_MECHANICS: readonly string[] = [
  'routes/debug.ts -> doc-cache',
  'routes/debug.ts -> document-store',
  'routes/document.ts -> version-store',
  'routes/document.ts -> auto-version',
  'routes/document/maintenance.ts -> document-store',
  'routes/document/maintenance.ts -> version-store',
  'routes/document/metadata.ts -> names-store',
  'routes/document/versions.ts -> document-store',
  'routes/document/versions.ts -> version-store',
  'routes/files.ts -> file-gc',
  'routes/files.ts -> version-store',
  'routes/files.ts -> workspace-lock',
  // Mechanics kept outside `store/`, counted since the scan learned to look
  // for them. Each is a row-keeping store or a disk layout a route holds by
  // type or by value; none is an operation a second surface would re-write
  // yet, so they are ledgered rather than moved.
  //
  // The route takes the store as an injected dependency and calls it for a
  // single read or write with no rule of its own around it.
  'routes/invitation-link.ts -> security/invitation-store',
  'routes/replica-key.ts -> security/workspace-replica-key-store',
  // The sign-in routes drive the attempt and session stores around a
  // provider redirect: the attempt row carries the state/nonce across it, and
  // the session cookie name is the one constant the route shares with the
  // store that mints it.
  'routes/sign-in.ts -> security/sign-in-attempt-store',
  'routes/sign-in.ts -> security/sign-in-session-store',
  // The people-administration decisions are `security/people-administration`'s
  // and the route holds none; what remains is the invitation store's type,
  // handed on to `invitation-link.ts` to issue the tenant invitation.
  'routes/tenant-people.ts -> security/invitation-store',
  // `export/` counted since the scan learned to look for it. `headless-export`
  // reads the stored document through the store's module-level handle and
  // renders it, so "export a document" cannot be asked of it without the
  // keeper's storage coming along — the shape ADR-0018 names, in two routes.
  // The font modules keep files under the data directory themselves.
  'routes/document/export-svg.ts -> export/headless-export',
  'routes/export.ts -> export/headless-export',
  'routes/fonts.ts -> export/install-font',
  'routes/fonts.ts -> export/installed-fonts',
  // Top-level mechanisms kept beside the server's roots, counted since the
  // finder took the mechanics layer's own definition (`adapter-reach.ts`) for
  // what a mechanic is. `files.ts` writes an upload through `atomic-write` and
  // the export routes resolve a caller-chosen path through `output-path`, the
  // storage rules an operation over files would own; `mcp-apps.ts` reads the
  // daemon's `config` for the widget it serves. The type-only edge from
  // `document-output-path-error.ts` is the error shape of that same resolution.
  'mcp/mcp-apps.ts -> server/config',
  'routes/document-output-path-error.ts -> server/output-path',
  'routes/document/export-svg.ts -> server/output-path',
  'routes/export.ts -> server/output-path',
  'routes/files.ts -> server/atomic-write',
  // The one helper every address-parsing route shares. Its own reach is the
  // workspace registry the store holds at module level; handing it the registry
  // the way `createApp` hands routes everything else retires the entry.
  'workspace-handle.ts -> document-store',
]

/**
 * How many entries {@link ADAPTERS_REACHING_MECHANICS} may hold — a ratchet,
 * not a budget.
 *
 * ADR-0018 is Accepted, so this debt is scheduled rather than tolerated, and
 * the number is the only thing that makes "scheduled" mean anything a build
 * can check. Pinned by equality on purpose: adding an edge fails until
 * someone raises this line, and PAYING one off fails until someone lowers it.
 * Both halves matter — a ceiling nobody lowers stops recording progress and
 * becomes a budget, which is the thing it exists not to be.
 *
 * Raising it is a decision, not a fix. Do it only when the alternative is
 * worse than the debt, and say in the PR why the operation could not go to
 * server-core instead. The ADR's scheduled burn-down is COMPLETE
 * (2026-09-02): restore.ts, live-doc.ts, workspace-document.ts and the
 * websocket route (since deleted) were all translation-only over the
 * LiveDocuments/WorkspaceDocuments seams. The edges left are the unscheduled adapters — each still a
 * candidate for the same treatment, none yet ordered.
 *
 * Two of the 21 went when ADR-0029 retired the branch: `routes/branches.ts`
 * reached both `branch-merge` and `branches-store`, and the route no longer
 * exists. A third went with the version row's thumbnail —
 * `routes/document/thumbnails.ts` reached `version-store`, and the route is
 * gone with the feature. Debt paid by deletion rather than by relocation,
 * which is the cheapest way this number ever comes down.
 *
 * It went 14 -> 24 when the scan widened past `store/` to the keeper's
 * other mechanics: ten edges that were already there, never debt anyone had
 * been asked about — eight `security/*-store` (people, sessions, keys,
 * invitations), one `daemon/log-rotation` and one `tenant/data-layout`. Two
 * of the eight went straight away, 24 -> 22, when
 * `routes/tenant-people.ts` stopped holding the people-administration
 * decisions and the stores they act on, and one more, 22 -> 21, when
 * `routes/files.ts` took the data layout `createApp` is handed instead of
 * joining `tenant/data-layout`'s paths from the process data dir itself. That
 * was a measurement catching up with the code, not new debt. Then 21 -> 20,
 * when `routes/workspace-people.ts` stopped holding the workspace-level
 * decisions (`isUser` before an add, the role and removal refusals) and the
 * member store they act on: they are `security/people-administration`'s now,
 * and the operator's `grant-member` runs the same ones. And 20 -> 19, when
 * `routes/document.ts -> auto-checkpoint` went: the root installs the
 * checkpoint scheduler through its background-work declaration instead of
 * the router doing it as a side effect of being built.
 *
 * Then 19 -> 24, and that is measurement catching up with the code, not new
 * debt: the finder now reads import specifiers from the AST (a dynamic
 * `import()` and a side-effect import count, a commented-out one does not —
 * on the real tree that found nothing the text match had not), and it counts
 * two things the old matcher could not see. Four are `export/` edges: two
 * routes hold `export/headless-export` and `routes/fonts.ts` holds the two
 * font modules. One is `workspace-handle.ts`, the helper nine routes share,
 * whose own reach into the store's registry no route showed. All five already
 * existed.
 *
 * Then 24 -> 23, when `routes/runtime.ts -> daemon/log-rotation` went with
 * the route: the daemon keeps no log file, so the prune had nothing to delete.
 *
 * Then 23 -> 28, and again measurement and not new debt: the finder now takes
 * the mechanics layer from `adapter-reach.ts`, the one definition
 * `mcp-server-layer-order.test.ts` also reads, so the top-level mechanisms
 * (`atomic-write`, `output-path`, `config`) count where only the directories
 * did. Five edges that already existed.
 *
 * Then 28 -> 29, the same again: entitlement is now a list of modules NAMED, not
 * the directories `security/` and `tenant/`, so `tenant/storage-report` — a disk
 * walk filed under an entitled directory — counts. One edge that already existed.
 *
 * Then 29 -> 28, when `createApp` began handing the runtime route its storage
 * report as a dependency instead of the route importing the disk walk.
 *
 * Then 28 -> 27, when it handed the route the compaction stamp the same way
 * (`readLatestCompactedAt`), so the route opens no workspace record itself.
 */
export const ADAPTERS_REACHING_MECHANICS_CEILING = 27

/**
 * Modules under `store/` the adapter rule does NOT count.
 *
 * `corrupt-stored-data` is an error taxonomy, not a mechanic: an adapter
 * calling `isCorruptStoredDataError` to choose a status code is doing
 * translation, which is exactly an adapter's job. Listing it would put five
 * entries in the allowlist above that could never legitimately shrink,
 * breaking the one property that makes that list trustworthy.
 */
/**
 * Files inside an adapter tree that are NOT adapters, and why.
 *
 * ADR-0018 already exempts the composition root's own wiring — `di/`,
 * `app.ts`, `http-server.ts` — because knowing the mechanics is exactly its
 * job. That exemption was written as a directory list, which misses a
 * composition root that happens to live under `mcp/`.
 *
 * These are skipped WHOLE rather than having their edges listed in
 * ADAPTERS_REACHING_MECHANICS, because that list's whole value is that it can
 * only shrink: a composition root's imports are not debt anyone will ever pay
 * off, and five permanently-stuck entries teach a reader to stop reading it.
 * The same reasoning already excludes `corrupt-stored-data` below.
 */
export const ADAPTER_SCAN_EXEMPT_FILES: readonly string[] = [
  // Empty: no composition root sits inside an adapter tree. The stdio root is
  // `server/stdio-root.ts`, beside the other roots, and `mcp/server.ts` is a
  // library that takes the deps it is handed. A file that does must be added
  // with its reason.
]

/**
 * Top-level `server/*.ts` modules that routes import and that are translation
 * shared between them, scanned as adapters.
 *
 * A route importing `store/` shows an edge. A route importing a helper that
 * imports `store/` shows none, so the reach hides one hop away behind every
 * caller: `workspace-handle.ts` turns an address's handle into a workspace id
 * for nine routes through `workspaceRegistry()`, and until it was named here no
 * guard saw that. It is classified as an adapter rather than as a mechanic
 * because what it holds is the 400 for a malformed address and the per-request
 * memo — translation — with the one registry read inside it; calling it a
 * mechanic would ledger nine routes for a single debt.
 *
 * Named, not discovered: following every `server/*.ts` an adapter imports also
 * reaches `shared-background-work.ts`, a composition root's wiring whose edges
 * are not debt, and a guess at which helpers count would hide the decision. A
 * new helper that reaches a mechanic is a blind spot until it is listed here —
 * `mcp-server-layer-order.test.ts` holds this list to the top-level files it
 * files in the adapters layer, so the two cannot name different helpers.
 */
export const ADAPTER_HELPER_FILES: readonly string[] = ['workspace-handle.ts', 'app-helpers.ts']

/**
 * `store-scope` is a value an adapter is HANDED, not a mechanic it reaches for:
 * the directory and tenant its routes serve, which `createApp` derives once
 * from the layout its root booted the deps over. Holding the type is what lets
 * a router pass the directory on to the store functions it calls, and counting
 * it here would ledger nine routes for holding the contract. What an adapter
 * must NOT do — fall back to the process's directory, or build a scope itself —
 * is `adapter-process-global-check`'s scope scan, which bans `globalStoreScope`
 * and `storeScope(` outside `createApp`.
 */
export const MECHANICS_NOT_SCANNED: readonly string[] = ['corrupt-stored-data', 'store-scope']

/**
 * A published subpath that only some importers may load from SHIPPED source.
 *
 * The manifest checks judge a package, and a package can be a legal dependency
 * while one of its entries is not: `canvas-render` may depend on
 * `plugin-visual`, whose `/ui` entry is React, and on `facet-engine`, whose
 * `/testing` entry pulls `fast-check`, a devDependency. Neither shows in a
 * dependency list, and only a built bundle (bigger, or missing a module) shows
 * the import.
 *
 * `consumers` are workspace directories whose non-test source may import the
 * subpath; empty means no shipped file may, only tests. Keyed by the specifier
 * as written. `subpath-consumers.test.ts` reads every manifest's `exports` and
 * fails an entry that names no export, an export that carries a test-only
 * marker or a `.tsx` target without an entry here, and a consumer that no
 * longer imports the subpath — so this table cannot outlive what it records.
 */
export interface SubpathPolicy {
  readonly consumers: readonly string[]
  readonly reason: string
}

const TEST_ONLY_HELPER =
  'doubles and conformance suites for tests; they import vitest or fast-check'

export const SUBPATH_POLICY: Readonly<Record<string, SubpathPolicy>> = {
  '@kamiazya/whiteboard-plugin-visual/ui': {
    consumers: ['apps/web'],
    reason:
      'the React half of the plugin; every other entry is data or render and is loaded by Node and the layout worker, which this one would put React into',
  },
  '@kamiazya/whiteboard-facet-engine/testing': {
    consumers: [],
    reason: `fast-check arbitraries for a plugin author's own facet tests (fast-check is a devDependency of the engine); ${TEST_ONLY_HELPER}`,
  },
  '@kamiazya/whiteboard-model/test-utils': { consumers: [], reason: TEST_ONLY_HELPER },
  '@kamiazya/whiteboard-ports/test-utils': { consumers: [], reason: TEST_ONLY_HELPER },
  '@kamiazya/whiteboard-canvas-render/test-utils': { consumers: [], reason: TEST_ONLY_HELPER },
  '@kamiazya/whiteboard-server-core/test-utils/embedder-contract': {
    consumers: [],
    reason: TEST_ONLY_HELPER,
  },
  '@kamiazya/whiteboard-server-core/test-utils/fake-version-history': {
    consumers: [],
    reason: TEST_ONLY_HELPER,
  },
  '@kamiazya/whiteboard-daemon-client/test-utils/document-backend-contract': {
    consumers: [],
    reason: TEST_ONLY_HELPER,
  },
  '@kamiazya/whiteboard-daemon-client/test-utils/sse-stream-source-contract': {
    consumers: [],
    reason: TEST_ONLY_HELPER,
  },
  '@kamiazya/whiteboard-daemon-client/api-contracts/roundtrip.test-helper': {
    consumers: [],
    reason: TEST_ONLY_HELPER,
  },
}

export function allowedDependencies(packageName: string): readonly string[] {
  return ARCHITECTURE_MAP[packageName]?.allowedInternalDeps ?? []
}

export function allowedThirdPartyDependencies(packageName: string): readonly string[] {
  return ARCHITECTURE_MAP[packageName]?.allowedThirdParty ?? []
}

/**
 * Every `BoundaryViolationKind` a package's own source is exempt from,
 * combining the automatic loro-crdt exemption (a package may import
 * `loro-crdt` from source iff it records it in `allowedThirdParty` — one list,
 * read here and nowhere else) with each package's explicit
 * `exemptBoundaryViolationKinds`, and — when `fileInSrc` (the path
 * relative to the package's `src/`, `/`-separated) is given — that file's
 * `exemptBoundaryFiles` entry. `repo-coverage.test.ts` filters
 * `scanSourceForBoundaryViolations` output through this before asserting
 * zero violations.
 */
export function exemptedBoundaryViolationKinds(
  packageName: string,
  fileInSrc?: string,
): ReadonlySet<BoundaryViolationKind> {
  const entry = ARCHITECTURE_MAP[packageName]
  const kinds = new Set<BoundaryViolationKind>(entry?.exemptBoundaryViolationKinds ?? [])
  if (entry?.allowedThirdParty.includes('loro-crdt')) {
    kinds.add('loro-crdt-import')
  }
  if (fileInSrc !== undefined) {
    for (const kind of entry?.exemptBoundaryFiles?.[fileInSrc]?.kinds ?? []) kinds.add(kind)
  }
  return kinds
}
