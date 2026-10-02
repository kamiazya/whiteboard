import { ARCHITECTURE_MAP, allowedDependencies } from './architecture-map.js'

export interface DirectionViolation {
  readonly packageName: string
  readonly dependencyName: string
}

export interface PackageManifest {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

export interface DirectionOptions {
  /**
   * Also read `devDependencies`. Off by default: for a shared-layer package a
   * devDependency is tooling, not a runtime coupling. ON for a composition
   * root that BUNDLES its workspace packages — `mcp-server` lists every
   * `@kamiazya/whiteboard-*` it imports under `devDependencies` because
   * tsdown's `noExternal` inlines them into the published dist, so there they
   * are the runtime couplings, and a check blind to that field was vacuous.
   */
  readonly includeDevDependencies?: boolean
}

/**
 * Only a dependency that names ANOTHER package in the architecture map is a
 * candidate direction violation — third-party deps (zod, unified, ...)
 * aren't part of this table at all and are always allowed.
 * `devDependencies` are inspected only when `includeDevDependencies` is set.
 */
export function checkDependencyDirection(
  manifest: PackageManifest,
  options: DirectionOptions = {},
): DirectionViolation[] {
  const violations: DirectionViolation[] = []
  const allowed = new Set(allowedDependencies(manifest.name))
  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...(options.includeDevDependencies ? Object.keys(manifest.devDependencies ?? {}) : []),
  ]

  for (const dependencyName of declared) {
    const isMappedPackage = dependencyName in ARCHITECTURE_MAP
    if (isMappedPackage && !allowed.has(dependencyName)) {
      violations.push({ packageName: manifest.name, dependencyName })
    }
  }

  return violations
}
