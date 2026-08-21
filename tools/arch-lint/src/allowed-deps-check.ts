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
 *
 * The list is a RECORD of what has been checked against the shared layer's
 * criterion (runs unchanged on Node, the browser and Workers; does not break
 * the published build), not a quota. This check exists so a dependency
 * arrives with that reasoning written down, not so the count stays low — see
 * architecture-map.md. Answering a violation by adding the entry IS the
 * intended fix when the dependency meets the criterion; the failure message
 * says so, because the check's shape otherwise reads as a refusal.
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
