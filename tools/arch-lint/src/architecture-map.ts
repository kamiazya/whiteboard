import type { BoundaryViolationKind } from './scanner.js'

/**
 * Data-driven mirror of the "May depend on" column in
 * .claude/rules/architecture-map.md, extended with each package's allowed
 * third-party (non-workspace) dependencies. `allowedInternalDeps` feeds
 * `direction-check.ts` (internal-package direction); `allowedThirdParty`
 * feeds `allowed-deps-check.ts` (everything else a `dependencies` entry
 * could name). `devDependencies` are exempt from both — tooling, not
 * runtime coupling — per the same doc.
 *
 * `exemptBoundaryViolationKinds` opts a package OUT of specific
 * `scanner.ts` violation kinds it legitimately needs — e.g. canvas-viewer
 * is a browser-runtime UI package (DOM globals are its whole job) with one
 * embedded Node-side build-time module (`widget/build-fonts-module.ts`
 * uses `Buffer` to base64-encode font bytes at build time), so it is
 * exempted from `dom-global`/`node-ambient-global` while still banned from
 * `node-builtin-import`/`inversify-import` like every other shared-layer
 * package.
 */
export interface PackageArchEntry {
  readonly allowedInternalDeps: readonly string[]
  readonly allowedThirdParty: readonly string[]
  readonly exemptBoundaryViolationKinds?: readonly BoundaryViolationKind[]
}

export const ARCHITECTURE_MAP: Readonly<Record<string, PackageArchEntry>> = {
  '@kamiazya/whiteboard-model': {
    allowedInternalDeps: [],
    allowedThirdParty: ['zod'],
  },
  '@kamiazya/whiteboard-codec': {
    allowedInternalDeps: ['@kamiazya/whiteboard-model'],
    allowedThirdParty: [
      'zod',
      'unified',
      'remark-parse',
      'remark-stringify',
      'remark-gfm',
      'remark-math',
      'yaml',
    ],
  },
  '@kamiazya/whiteboard-scene': {
    // The scene vocabulary and the renderer/plugin contract. Types only, and
    // positioned rather than populated: it sits below the renderer and below
    // every plugin so neither imports the other to agree what a scene is.
    allowedInternalDeps: ['@kamiazya/whiteboard-model', '@kamiazya/whiteboard-facet-engine'],
    allowedThirdParty: [],
  },
  '@kamiazya/whiteboard-canvas-render': {
    // codec: the mdast body parser this package DEFAULTS to. Every consumer
    // already bundles codec to pass it in, so the dependency adds nothing to
    // any bundle and removes the same line from seven call sites.
    // plugin-visual: resolveCanvasEdgeStyle is the DEFAULT read for edge
    // style (facet first, legacy x-whiteboard.edgeRouting fallback) — the
    // lowlight lesson again: an opt-in resolution step at four call sites
    // is a step that gets missed, so the shared renderer owns the default.
    // The same package owns the icon geometry, for the same reason: the
    // renderer draws exactly the names `visual.symbol` enumerates.
    //
    // ponytail: this is a hard-coded dependency on one plugin. The backend
    // already accepts caller-supplied glyph geometry, so the upgrade path
    // is injection — the layout pass takes the resolvers the way it takes
    // `highlightCode`. Worth doing when a SECOND plugin wants to change how
    // a node is drawn; before that it is indirection with one implementation.
    // facet-engine: the theme TOKEN CONTRACT (ADR-0030 decision 3) — the one
    // shape a registered theme has, declared in the engine so ADR-0013
    // decision 8 can build on it without moving it; this package maps it
    // onto its palette. zod-only, so it holds on Node, the browser and a
    // worker alike — checked before adopting.
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-plugin-visual',
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-scene',
    ],
    // css-line-break: deciding WHERE a line may break is this package's own
    // job, and the answer is a Unicode standard (UAX #14 + CSS `line-break`,
    // which is where Japanese kinsoku lives), not something to hand-roll from
    // a character table. Pure and DOM-free, so it holds in Node, the browser
    // and a worker alike — verified before adopting.
    // BudouX (phrase boundaries for Japanese) is deliberately NOT here: it is
    // vendored under src/vendor/budoux, because depending on it drags in
    // linkedom and the native canvas package and breaks the published build.
    // lowlight/highlight.js: the DEFAULT implementation of this package's own
    // `highlightCode` seam, behind the `/highlight` subpath so the barrel
    // never drags a highlighter into a consumer that renders no code. It sits
    // here because canvas-render is the only package all three surfaces that
    // render a markdown body can see — the editor, the viewer (and the MCP
    // Apps widget through it), and export — and the alternative is the same
    // scope-to-role table written out three times. Pure JS, no DOM and no
    // `node:*`, so it holds on Node, the browser and a Worker alike.
    allowedThirdParty: ['zod', 'css-line-break', 'lowlight', 'highlight.js'],
  },
  '@kamiazya/whiteboard-ports': {
    allowedInternalDeps: ['@kamiazya/whiteboard-model'],
    allowedThirdParty: ['zod'],
  },
  // The facet ENGINE (ADR-0013): definePlugin/defineFacet, the registry,
  // write validation and compat resolution, plus the bundled `visual`
  // plugin. Machinery, not schemas — which is why it is not in model (whose
  // rule excludes runtime behavior beyond validation). Pure zod over model
  // types, so it holds on Node, the browser and a worker alike.
  // The engine, and nothing a plugin owns. Its dependency list is empty of
  // workspace packages BY RESULT, not by rule: the model types it once held
  // left with the `visual` plugin, which is the shape ADR-0013 asks for —
  // the engine is generic over schemas it never names.
  '@kamiazya/whiteboard-facet-engine': {
    allowedInternalDeps: [],
    allowedThirdParty: ['zod'],
  },
  // Lexical search: a dictionary-free tokenizer (latin words, CJK bigrams),
  // BM25 ranking, snippets, and the ONE definition of what text a document
  // contributes. Pure and runtime-agnostic on purpose — the daemon and the
  // browser must rank the same corpus the same way, and a second copy of
  // either half is a second set of answers.
  // It takes content already read (a body, or a canvas), so it needs
  // neither the CRDT nor the bridge — model's types are the whole surface.
  '@kamiazya/whiteboard-search': {
    allowedInternalDeps: ['@kamiazya/whiteboard-model'],
    allowedThirdParty: [],
  },
  // What the documents of a workspace point at, as a graph: the facts one
  // document contributes, the aggregate that answers backlinks and unlinked
  // mentions, and the frontier-stamped cache that keeps those facts between
  // reads. Its own package because BOTH keepers answer these questions, and
  // server-core — where it grew — carries hono and the daemon's tool surface
  // into anything that imports it. The keeper-specific half is one port,
  // `DocumentContentSource`; everything that decides what a reference IS
  // stays here, once.
  '@kamiazya/whiteboard-reference-graph': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-ports',
      '@kamiazya/whiteboard-loro-adapter',
      '@kamiazya/whiteboard-search',
    ],
    // loro-crdt: the port hands the cache a LoroDoc, which extraction reads.
    // zod: the aggregate's facts and the backlink entry are schemas the
    // daemon's published output schema composes.
    allowedThirdParty: ['loro-crdt', 'zod'],
  },
  '@kamiazya/whiteboard-loro-adapter': {
    // Deliberately NOT ports: this package adapts loro-crdt to the model and
    // knows nothing about where a document sits, so it implements no port.
    // The port implementations live in the composition roots.
    allowedInternalDeps: ['@kamiazya/whiteboard-model'],
    // loro-crdt: this package owns the LoroDoc<->model bridge (see
    // .claude/rules/package-loro-adapter.md), so it's the one shared-
    // layer package (besides server-core, which re-exposes the bridge via
    // its Loro-backed store ports) allowed to import it directly.
    // zod: the bridge validates the persisted `core` LoroMap entries against
    // model's storedCoreFacetsSchema field-by-field on read.
    allowedThirdParty: ['loro-crdt', 'zod'],
  },
  '@kamiazya/whiteboard-workspace-index': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-ports',
      '@kamiazya/whiteboard-loro-adapter',
    ],
    // loro-crdt: this package reads a workspace's tree, so it needs the same
    // runtime `loro-adapter` does. It exists as its own package precisely
    // because neither of the two that could otherwise host it can: this needs
    // BOTH ports and loro-crdt, and `loro-adapter` is deliberately closed to
    // ports while `ports` is deliberately closed to loro-crdt.
    allowedThirdParty: ['loro-crdt'],
  },
  '@kamiazya/whiteboard-history': {
    // A document's history as pure mechanics over the workspace record: the
    // checkpoint scheduler, version retention, and frontier encoding. Both
    // keepers run them; what differs between the keepers is where the rows
    // live, which stays in each composition root. loro-crdt because a
    // checkpoint's identity is a frontier of the record. model for the one
    // base64 codec a frontier is stored through. Branch operations
    // and merge planning were here too until ADR-0029 retired the branch.
    allowedInternalDeps: ['@kamiazya/whiteboard-model'],
    allowedThirdParty: ['loro-crdt'],
  },
  '@kamiazya/whiteboard-server-core': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-canvas-render',
      '@kamiazya/whiteboard-ports',
      '@kamiazya/whiteboard-loro-adapter',
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-plugin-visual',
      '@kamiazya/whiteboard-search',
      '@kamiazya/whiteboard-reference-graph',
    ],
    allowedThirdParty: ['hono', 'zod', 'loro-crdt'],
  },
  // The facet system's React half: a LIBRARY, and nothing more. It knows
  // the engine and no plugin — `facet-engine` holds the same system's data
  // half and cannot take React, since it runs on Node, in a worker and in
  // the browser. A plugin's own components are the plugin's, which is why
  // nothing here may depend on `plugin-visual` (and why that package
  // depends on this one).
  '@kamiazya/whiteboard-facet-ui': {
    allowedInternalDeps: ['@kamiazya/whiteboard-facet-engine'],
    // lucide-react: the icon set the editor already draws from, pure SVG
    // components with no DOM or `node:*` reach — it holds wherever React
    // does. `react-dom` is deliberately absent: this package renders
    // elements and never mounts them.
    allowedThirdParty: ['lucide-react', 'react'],
    exemptBoundaryViolationKinds: ['dom-global'],
  },
  // The bundled `visual` plugin, as an ORDINARY plugin package. The engine
  // does not import it and nothing here is privileged; "bundled" means only
  // that this repo ships it. Its data half runs wherever a document is read
  // (default entry, react-free) and its React half behind `/ui` — the split
  // is the plugin's, and it is the shape a third party copies.
  //
  // It owns the vendored icon geometry because `visual.symbol`'s schema is
  // what enumerates those names; the renderer draws from the same table, so
  // `canvas-render` depends on this package rather than the other way round.
  // That geometry is also REGISTERED as an `assets.icons` bundle, which is
  // how a declared picker draws it without anyone importing a component.
  //
  // `lucide-react` is deliberately gone. This package vendors the geometry
  // (see `src/icons/README.md`) and its last importer was the hand-written
  // symbol editor, retired when the picker vocabulary could express that
  // facet. Nothing here renders a lucide COMPONENT any more.
  '@kamiazya/whiteboard-plugin-visual': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-facet-ui',
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-scene',
    ],
    allowedThirdParty: ['react', 'zod'],
    exemptBoundaryViolationKinds: ['dom-global'],
  },
  '@kamiazya/whiteboard-canvas-viewer': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-canvas-render',
    ],
    allowedThirdParty: ['@modelcontextprotocol/ext-apps', 'react', 'react-dom', 'zod'],
    exemptBoundaryViolationKinds: ['dom-global', 'node-ambient-global'],
  },
  // The daemon's browser-safe client half (extracted from mcp-server's
  // src/shared, where it was held browser-safe only by a convention scan):
  // the /api Zod contracts the web app parses, the fetch/WS/SSE document
  // backends, the api-client wrapper, and the shared backend contract test
  // suites. Being in THIS table is the point of the extraction — the
  // browser-safety property is now structural (no node:*, scanned like any
  // shared package) instead of positional. DOM globals are its normal job
  // (WebSocket/EventSource/fetch), the same exemption canvas-viewer holds.
  // server-core: the version-entry and operator contracts the /api routes
  // publish are defined beside the routes' own logic and re-exported here.
  '@kamiazya/whiteboard-daemon-client': {
    allowedInternalDeps: ['@kamiazya/whiteboard-model', '@kamiazya/whiteboard-server-core'],
    // @opentelemetry/api alone: the no-op propagation surface api-client
    // injects trace headers through when the embedding page registers a real
    // SDK. The SDK packages themselves were deleted with the dead
    // enableBrowserTracing half (zero production callers).
    // multiformats: the reference implementation of multibase + multicodec,
    // which is what a `did:key` IS. Pure JS, zero dependencies, no DOM and no
    // `node:*` — verified before adopting, so it holds in Node, the browser
    // and a worker alike. Adopted over a hand-written base58 because that
    // version's leading-zero branches are unreachable from this package's one
    // call site and so could never be covered by a test here.
    allowedThirdParty: ['zod', '@opentelemetry/api', 'multiformats'],
    exemptBoundaryViolationKinds: ['dom-global'],
  },
  // Composition root (Node CLI/daemon), never a runtime dependency of any
  // shared-layer package. Registered here with an empty allowedInternalDeps
  // so direction-check.ts flags the reverse import if a shared package ever
  // adds it as a dependency; its own source is NOT scanned by
  // repo-coverage.test.ts (it is allowed node:*/inversify — see
  // architecture-map.md rule 2).
  '@kamiazya/whiteboard-mcp': {
    // daemon-client: the browser-safe client half extracted from this
    // package's own src/shared. The re-export shims and the published client
    // subpaths are retired; the server imports the package directly and tsup
    // noExternal inlines it into the published dist.
    allowedInternalDeps: ['@kamiazya/whiteboard-daemon-client'],
    allowedThirdParty: [],
  },
  // The browser extension (ADR-0050): a composition root for the extension
  // runtime, relaying the hosted app to the native host. It reads only the
  // names the browser checks from daemon-client, and is registered so a
  // shared package that took a dependency on it would be flagged.
  '@kamiazya/whiteboard-extension': {
    allowedInternalDeps: ['@kamiazya/whiteboard-daemon-client'],
    allowedThirdParty: [],
  },
  // The OTHER composition root (browser). Registered for the same reason
  // `@kamiazya/whiteboard-mcp` is — being in this table is what makes
  // direction-check.ts flag a shared package that takes a dependency on it —
  // and, unlike that one, with its real allowed set, because apps/web's own
  // manifest is direction-checked (see repo-coverage.test.ts's
  // COMPOSITION_ROOTS).
  //
  // The daemon's browser-safe client half is `@kamiazya/whiteboard-daemon-client`
  // (a shared-layer package this tool scans structurally); apps/web reads it
  // directly, and `@kamiazya/whiteboard-mcp` deliberately left this list when
  // the subpath re-export shims retired — a composition root depending on the
  // other composition root is exactly what this entry exists to flag.
  '@kamiazya/whiteboard-web': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-canvas-render',
      '@kamiazya/whiteboard-loro-adapter',
      '@kamiazya/whiteboard-canvas-viewer',
      '@kamiazya/whiteboard-facet-ui',
      '@kamiazya/whiteboard-plugin-visual',
      '@kamiazya/whiteboard-daemon-client',
      '@kamiazya/whiteboard-ports',
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-search',
      '@kamiazya/whiteboard-workspace-index',
      // history: the checkpoint and retention mechanics the browser keeper
      // runs, the same ones the daemon does — so the rules for changing one
      // live in a package below both rather than in either root.
      '@kamiazya/whiteboard-history',
      // reference-graph: the browser keeper answers "what links here" from
      // the same facts, aggregate and cache the daemon does — its Connections
      // panel — so it reads the package rather than a copy of it.
      '@kamiazya/whiteboard-reference-graph',
    ],
    allowedThirdParty: [],
  },
}

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
  'routes/document/auto-version.ts -> version-store',
  'routes/document/maintenance.ts -> document-store',
  'routes/document/maintenance.ts -> version-store',
  'routes/document/metadata.ts -> names-store',
  'routes/document/versions.ts -> document-store',
  'routes/document/versions.ts -> version-store',
  'routes/files.ts -> file-gc',
  'routes/files.ts -> version-store',
  'routes/files.ts -> workspace-lock',
  'routes/runtime.ts -> document-store',
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
  // `POST /api/runtime/logs/prune` is daemon housekeeping with one caller;
  // no second surface asks for it, so there is no operation to share yet.
  'routes/runtime.ts -> daemon/log-rotation',
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
 * (2026-09-02): restore.ts, live-doc.ts, workspace-document.ts and ws.ts
 * are all translation-only over the LiveDocuments/WorkspaceDocuments
 * seams. The edges left are the unscheduled adapters — each still a
 * candidate for the same treatment, none yet ordered.
 *
 * `routes/document.ts -> auto-checkpoint` went, 21 -> 20, when the root began
 * installing the checkpoint scheduler through its background-work
 * declaration instead of the router doing it as a side effect of being built.
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
 * and the operator's `grant-member` runs the same ones.
 */
export const ADAPTERS_REACHING_MECHANICS_CEILING = 20

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
  // Empty: `mcp/index.ts`, the McpServer factory and stdio entry, stood here
  // while it called the store's own boot functions. It now boots through
  // `di/boot-self-host-deps.ts` like every other root, so nothing needs the
  // exemption. A file that does must be added with its reason.
]

export const MECHANICS_NOT_SCANNED: readonly string[] = ['corrupt-stored-data']

export function allowedDependencies(packageName: string): readonly string[] {
  return ARCHITECTURE_MAP[packageName]?.allowedInternalDeps ?? []
}

export function allowedThirdPartyDependencies(packageName: string): readonly string[] {
  return ARCHITECTURE_MAP[packageName]?.allowedThirdParty ?? []
}

/**
 * The scanner's loro-crdt exemption (see `scanner.ts` / `repo-coverage.test.ts`)
 * is data-driven from this set, not an ad hoc heuristic: a package may import
 * `loro-crdt` from source iff it's declared here as an allowed third-party
 * dependency.
 */
export function packagesAllowedToImportLoroCrdt(): readonly string[] {
  return Object.entries(ARCHITECTURE_MAP)
    .filter(([, entry]) => entry.allowedThirdParty.includes('loro-crdt'))
    .map(([packageName]) => packageName)
}

/**
 * Every `BoundaryViolationKind` a package's own source is exempt from,
 * combining the automatic loro-crdt exemption above with each package's
 * explicit `exemptBoundaryViolationKinds`. `repo-coverage.test.ts` filters
 * `scanSourceForBoundaryViolations` output through this before asserting
 * zero violations.
 */
export function exemptedBoundaryViolationKinds(
  packageName: string,
): ReadonlySet<BoundaryViolationKind> {
  const entry = ARCHITECTURE_MAP[packageName]
  const kinds = new Set<BoundaryViolationKind>(entry?.exemptBoundaryViolationKinds ?? [])
  if (entry?.allowedThirdParty.includes('loro-crdt')) {
    kinds.add('loro-crdt-import')
  }
  return kinds
}
