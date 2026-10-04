import { ARCHITECTURE_MAP, allowedDependencies } from './architecture-map.js'
import { parseSource } from './ast-helpers.js'
import { collectModuleSpecifiers } from './scanner.js'

/**
 * The workspace package a module specifier names, if any: the specifier itself
 * or its subpath form (`@kamiazya/whiteboard-ports/test-utils`).
 */
function workspacePackageOf(specifier: string): string | undefined {
  return Object.keys(ARCHITECTURE_MAP).find(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  )
}

interface SourceDirectionViolation {
  readonly packageName: string
  readonly dependencyName: string
  readonly specifier: string
  readonly line: number
}

/**
 * Every import in one file of `packageName`'s source that names a workspace
 * package the map does not allow it.
 *
 * The manifest checks (`direction-check.ts`, `allowed-deps-check.ts`) read
 * declared dependencies only, and exempt `devDependencies` for a shared-layer
 * package. A devDependency still resolves for `tsc`, so a production file could
 * import it and no guard saw the edge: the "May depend on" column is enforced
 * on what a manifest says, never on what the source does. This reads the source
 * against the same column.
 */
export function findSourceDirectionViolations(
  packageName: string,
  fileName: string,
  source: string,
): SourceDirectionViolation[] {
  const allowed = new Set([packageName, ...allowedDependencies(packageName)])
  const sourceFile = parseSource(fileName, source)
  return collectModuleSpecifiers(sourceFile).flatMap(({ specifier, line }) => {
    const dependencyName = workspacePackageOf(specifier)
    return dependencyName !== undefined && !allowed.has(dependencyName)
      ? [{ packageName, dependencyName, specifier, line }]
      : []
  })
}
