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
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-plugin-visual',
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
  '@kamiazya/whiteboard-plugin-visual': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-facet-ui',
      '@kamiazya/whiteboard-model',
    ],
    allowedThirdParty: ['lucide-react', 'react', 'zod'],
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
  // Composition root (Node CLI/daemon), never a runtime dependency of any
  // shared-layer package. Registered here with an empty allowedInternalDeps
  // so direction-check.ts flags the reverse import if a shared package ever
  // adds it as a dependency; its own source is NOT scanned by
  // repo-coverage.test.ts (it is allowed node:*/inversify — see
  // architecture-map.md rule 2).
  '@kamiazya/whiteboard-mcp': {
    allowedInternalDeps: [],
    allowedThirdParty: [],
  },
  // The OTHER composition root (browser). Registered for the same reason
  // `@kamiazya/whiteboard-mcp` is — being in this table is what makes
  // direction-check.ts flag a shared package that takes a dependency on it —
  // and, unlike that one, with its real allowed set, because apps/web's own
  // manifest is direction-checked (see repo-coverage.test.ts's
  // COMPOSITION_ROOTS).
  //
  // `@kamiazya/whiteboard-mcp` is in that set deliberately. Rule 2 forbids a
  // SHARED package importing a composition root; one composition root
  // consuming the other's browser-safe client subpaths (`/api-client`,
  // `/api-contracts`, `/browser-contract`) is a different thing, and the
  // right place for the daemon's client contract is beside the daemon. Its
  // Node entrypoints are not reachable from here.
  '@kamiazya/whiteboard-web': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-canvas-render',
      '@kamiazya/whiteboard-loro-adapter',
      '@kamiazya/whiteboard-canvas-viewer',
      '@kamiazya/whiteboard-facet-ui',
      '@kamiazya/whiteboard-plugin-visual',
      '@kamiazya/whiteboard-mcp',
      '@kamiazya/whiteboard-ports',
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-search',
      '@kamiazya/whiteboard-workspace-index',
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
 * Mechanics an ADAPTER still reaches directly, pending ADR-0018's migration.
 *
 * Each entry is one `<adapter file> -> <mechanic module>` edge, relative to
 * `packages/mcp-server/src/server`. This list may only SHRINK: an edge that
 * is not here fails the build, and an entry that is no longer a real edge
 * fails it too, so an entry cannot outlive the debt it names. Same shape,
 * and the same reason, as {@link KNOWN_IMPORT_CYCLES}.
 *
 * The rule could not land without it. Every one of these exists today, and
 * enforcing the invariant on an empty list would simply have failed the
 * build — so the debt is recorded rather than the guard postponed until
 * after the migration it is meant to verify.
 */
export const ADAPTERS_REACHING_MECHANICS: readonly string[] = [
  'mcp/document-tools.ts -> workspace-lock',
  'routes/branches.ts -> branch-merge',
  'routes/branches.ts -> branches-store',
  'routes/debug.ts -> count-alive-nodes',
  'routes/debug.ts -> doc-cache',
  'routes/debug.ts -> document-store',
  'routes/document.ts -> auto-compact',
  'routes/document.ts -> version-store',
  'routes/document/auto-version.ts -> version-store',
  'routes/document/export-svg.ts -> document-store',
  'routes/document/live-doc.ts -> doc-cache',
  'routes/document/live-doc.ts -> document-store',
  'routes/document/live-doc.ts -> version-store',
  'routes/document/live-doc.ts -> workspace-lock',
  'routes/document/maintenance.ts -> doc-cache',
  'routes/document/maintenance.ts -> document-store',
  'routes/document/maintenance.ts -> version-store',
  'routes/document/metadata.ts -> names-store',
  'routes/document/restore.ts -> count-alive-nodes',
  'routes/document/restore.ts -> doc-cache',
  'routes/document/restore.ts -> document-store',
  'routes/document/restore.ts -> version-store',
  'routes/document/restore.ts -> workspace-lock',
  'routes/document/thumbnails.ts -> version-store',
  'routes/document/versions.ts -> document-store',
  'routes/document/versions.ts -> version-store',
  // The workspace-granularity twin of live-doc.ts, carrying the same four
  // edges for the same reasons — it retires WITH live-doc's when the sync
  // surface gets its server-core home.
  'routes/document/workspace-document.ts -> doc-cache',
  'routes/document/workspace-document.ts -> document-store',
  'routes/document/workspace-document.ts -> version-store',
  'routes/document/workspace-document.ts -> workspace-lock',
  'routes/document/workspaces.ts -> document-store',
  'routes/document/workspaces.ts -> names-store',
  'routes/export.ts -> document-store',
  'routes/files.ts -> file-gc',
  'routes/files.ts -> version-store',
  'routes/files.ts -> workspace-lock',
  'routes/runtime.ts -> document-store',
  'routes/ws.ts -> doc-cache',
  'routes/ws.ts -> document-store',
  'routes/ws.ts -> version-store',
  'routes/ws.ts -> workspace-lock',
]

/**
 * Modules under `store/` the adapter rule does NOT count.
 *
 * `corrupt-stored-data` is an error taxonomy, not a mechanic: an adapter
 * calling `isCorruptStoredDataError` to choose a status code is doing
 * translation, which is exactly an adapter's job. Listing it would put five
 * entries in the allowlist above that could never legitimately shrink,
 * breaking the one property that makes that list trustworthy.
 */
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
