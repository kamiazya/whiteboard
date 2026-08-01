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

/**
 * Only a dependency that names ANOTHER package in the architecture map is a
 * candidate direction violation — third-party deps (zod, unified, ...)
 * aren't part of this table at all and are always allowed. `devDependencies`
 * are never inspected: a `package.json` "dependencies" object is the only
 * input this function reads.
 */
export function checkDependencyDirection(manifest: PackageManifest): DirectionViolation[] {
  const violations: DirectionViolation[] = []
  const allowed = new Set(allowedDependencies(manifest.name))

  for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
    const isMappedPackage = dependencyName in ARCHITECTURE_MAP
    if (isMappedPackage && !allowed.has(dependencyName)) {
      violations.push({ packageName: manifest.name, dependencyName })
    }
  }

  return violations
}
