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
    // facet-engine: resolveCanvasEdgeStyle is the DEFAULT read for edge
    // style (facet first, legacy x-whiteboard.edgeRouting fallback) — the
    // lowlight lesson again: an opt-in resolution step at four call sites
    // is a step that gets missed, so the shared renderer owns the default.
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-facet-engine',
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
  '@kamiazya/whiteboard-facet-engine': {
    allowedInternalDeps: ['@kamiazya/whiteboard-model'],
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
  '@kamiazya/whiteboard-server-core': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-canvas-render',
      '@kamiazya/whiteboard-ports',
      '@kamiazya/whiteboard-loro-adapter',
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-search',
    ],
    allowedThirdParty: ['hono', 'zod', 'loro-crdt'],
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
      '@kamiazya/whiteboard-mcp',
      '@kamiazya/whiteboard-ports',
      '@kamiazya/whiteboard-facet-engine',
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
