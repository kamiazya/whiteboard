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
    allowedInternalDeps: ['@kamiazya/whiteboard-model', '@kamiazya/whiteboard-codec'],
    // css-line-break: deciding WHERE a line may break is this package's own
    // job, and the answer is a Unicode standard (UAX #14 + CSS `line-break`,
    // which is where Japanese kinsoku lives), not something to hand-roll from
    // a character table. Pure and DOM-free, so it holds in Node, the browser
    // and a worker alike — verified before adopting.
    // BudouX (phrase boundaries for Japanese) is deliberately NOT here: it is
    // vendored under src/vendor/budoux, because depending on it drags in
    // linkedom and the native canvas package and breaks the published build.
    allowedThirdParty: ['zod', 'css-line-break'],
  },
  '@kamiazya/whiteboard-ports': {
    allowedInternalDeps: ['@kamiazya/whiteboard-model'],
    allowedThirdParty: ['zod'],
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
    ],
    allowedThirdParty: [],
  },
}

/**
 * Cycles `cycle-check.ts`'s value-import graph detects today that are NOT
 * fixed yet — a shrinking allowlist in the same shape as
 * `exemptBoundaryViolationKinds` above: a group leaving this list is
 * progress, a group staying stale (no longer an actual cycle) is caught by
 * `repo-coverage.test.ts`'s allowlist-hygiene assertion. Each group is the
 * SORTED list of file paths (relative to repo root) in the strongly-
 * connected component, matching `findImportCycles`'s output shape exactly —
 * that's what makes a path-keyed lookup viable.
 *
 * Both entries below are closed by a deliberate `await import()`, not a
 * static edge both ways: the dynamic side only evaluates at call time,
 * after both modules have already finished loading, so neither carries the
 * module-eval TDZ risk a static-both-ways cycle (like the auth one this
 * check was added to catch) does. The coupling is still real — untangling
 * either is its own lane, not this one's.
 */
export const KNOWN_IMPORT_CYCLES: readonly (readonly string[])[] = [
  // doc-cache.ts imports document-store.ts statically; document-store.ts
  // closes the loop with `await import('./doc-cache.js')` at three eviction
  // call sites.
  //
  // This list used to say a call-time dynamic import carries "no module-eval
  // TDZ risk". It does not follow, and the sibling entry that said it was
  // removed after the risk landed: a request reached ws.ts's `sendRestoreEvent`
  // while ws.ts's own body had not run, so its module-level `const connections`
  // was still in its TDZ and the restore route 500'd with a bare ReferenceError
  // — intermittently, under a full parallel suite. A dynamic import defers
  // WHEN the module is fetched, not whether the fetch can observe a module that
  // is mid-evaluation somewhere up the stack. Treat an entry here as debt with
  // a known failure mode, not as a cycle that has been reasoned safe.
  [
    'packages/mcp-server/src/server/store/doc-cache.ts',
    'packages/mcp-server/src/server/store/document-store.ts',
  ],
]

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
