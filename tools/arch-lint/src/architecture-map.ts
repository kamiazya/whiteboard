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
  '@kamiazya/whiteboard-canvas-model': {
    allowedInternalDeps: [],
    allowedThirdParty: ['zod'],
  },
  '@kamiazya/whiteboard-canvas-codec': {
    allowedInternalDeps: ['@kamiazya/whiteboard-canvas-model'],
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
    allowedInternalDeps: ['@kamiazya/whiteboard-canvas-model'],
    allowedThirdParty: ['zod'],
  },
  '@kamiazya/whiteboard-canvas-ports': {
    allowedInternalDeps: ['@kamiazya/whiteboard-canvas-model'],
    allowedThirdParty: ['zod'],
  },
  '@kamiazya/whiteboard-canvas-workspace': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-canvas-model',
      '@kamiazya/whiteboard-canvas-codec',
      '@kamiazya/whiteboard-canvas-ports',
    ],
    // loro-crdt: this package owns the LoroDoc<->model bridge (see
    // .claude/rules/package-canvas-workspace.md), so it's the one shared-
    // layer package (besides server-core, which re-exposes the bridge via
    // its Loro-backed store ports) allowed to import it directly.
    // zod: the bridge validates the persisted `core` LoroMap entries against
    // canvas-model's canvasCoreMetaSchema field-by-field on read.
    allowedThirdParty: ['loro-crdt', 'zod'],
  },
  '@kamiazya/whiteboard-server-core': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-canvas-model',
      '@kamiazya/whiteboard-canvas-codec',
      '@kamiazya/whiteboard-canvas-render',
      '@kamiazya/whiteboard-canvas-ports',
      '@kamiazya/whiteboard-canvas-workspace',
    ],
    allowedThirdParty: ['hono', 'zod', 'loro-crdt'],
  },
  '@kamiazya/whiteboard-canvas-viewer': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-canvas-model',
      '@kamiazya/whiteboard-canvas-codec',
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
      '@kamiazya/whiteboard-canvas-model',
      '@kamiazya/whiteboard-canvas-codec',
      '@kamiazya/whiteboard-canvas-render',
      '@kamiazya/whiteboard-canvas-workspace',
      '@kamiazya/whiteboard-canvas-viewer',
      '@kamiazya/whiteboard-mcp',
    ],
    allowedThirdParty: [],
  },
}

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
