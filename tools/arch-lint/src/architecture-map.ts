/**
 * Data-driven mirror of the "May depend on" column in
 * .claude/rules/architecture-map.md, extended with each package's allowed
 * third-party (non-workspace) dependencies. `allowedInternalDeps` feeds
 * `direction-check.ts` (internal-package direction); `allowedThirdParty`
 * feeds `allowed-deps-check.ts` (everything else a `dependencies` entry
 * could name). `devDependencies` are exempt from both — tooling, not
 * runtime coupling — per the same doc.
 */
export interface PackageArchEntry {
  readonly allowedInternalDeps: readonly string[]
  readonly allowedThirdParty: readonly string[]
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
    allowedThirdParty: ['loro-crdt'],
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
