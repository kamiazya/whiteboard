import { ARCHITECTURE_MAP, allowedDependencies } from './architecture-map.js'

export interface DirectionViolation {
  readonly packageName: string
  readonly dependencyName: string
}

export interface PackageManifest {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
}

/**
 * The dependency objects that put a package in a consumer's install: a peer is
 * the consumer's to provide and an optional one is installed when it can be,
 * so both are runtime couplings exactly as `dependencies` is, and a check that
 * read only that field passed a reversing edge declared in either.
 */
export function runtimeDependencyNames(manifest: PackageManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]
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
 * `peerDependencies` and `optionalDependencies` always count (see
 * {@link runtimeDependencyNames}); `devDependencies` only when
 * `includeDevDependencies` is set.
 */
export function checkDependencyDirection(
  manifest: PackageManifest,
  options: DirectionOptions = {},
): DirectionViolation[] {
  const violations: DirectionViolation[] = []
  const allowed = new Set(allowedDependencies(manifest.name))
  const declared = [
    ...runtimeDependencyNames(manifest),
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
