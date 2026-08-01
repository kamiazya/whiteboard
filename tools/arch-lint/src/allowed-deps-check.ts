import { ARCHITECTURE_MAP, allowedThirdPartyDependencies } from './architecture-map.js'
import type { PackageManifest } from './direction-check.js'

export interface AllowedDepsViolation {
  readonly packageName: string
  readonly dependencyName: string
}

/**
 * A dependency that names another package in the architecture map is
 * direction-check.ts's concern, not this one — this check only inspects
 * the remaining, non-internal entries of a `package.json` "dependencies"
 * object against the package's declared `allowedThirdParty` list.
 * `devDependencies` are never inspected.
 */
export function checkAllowedDependencies(manifest: PackageManifest): AllowedDepsViolation[] {
  const violations: AllowedDepsViolation[] = []
  const allowedThirdParty = new Set(allowedThirdPartyDependencies(manifest.name))

  for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
    const isInternalPackage = dependencyName in ARCHITECTURE_MAP
    if (!isInternalPackage && !allowedThirdParty.has(dependencyName)) {
      violations.push({ packageName: manifest.name, dependencyName })
    }
  }

  return violations
}
