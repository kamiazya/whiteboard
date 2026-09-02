// Cross-PACKAGE dependency-cycle check, over workspace manifests. The
// source-level cycle check (cycle-check.ts) is intra-package by design, and
// the direction check reads `dependencies` only — so a loop closed through a
// devDependency was caught by nothing mechanical. This check reads BOTH
// dependency objects: a type-only edge legitimately lives in
// devDependencies, and that is precisely the door a cross-package loop
// walks in through.
//
// Filesystem-free (pure functions over supplied manifests) like every other
// check here; the repo wiring lives in the test. Cycle detection reuses
// cycle-check.ts's Tarjan SCC — a graph is a graph.

import { findImportCycles } from './cycle-check.js'
import type { PackageManifest } from './direction-check.js'

/**
 * Directed graph over the supplied manifests' names: an edge for every
 * dependency OR devDependency that names another supplied package.
 * Third-party dependencies fall out via set membership, so the caller
 * decides the workspace universe by what it passes in.
 */
function buildPackageGraph(manifests: readonly PackageManifest[]): Map<string, string[]> {
  const names = new Set(manifests.map((m) => m.name))
  const graph = new Map<string, string[]>()
  for (const m of manifests) {
    const targets = [
      ...Object.keys(m.dependencies ?? {}),
      ...Object.keys(m.devDependencies ?? {}),
    ].filter((dep) => names.has(dep))
    graph.set(m.name, [...new Set(targets)].sort())
  }
  return graph
}

/** Every package-level cycle, each sorted, the list sorted — deterministic. */
export function findPackageCycles(manifests: readonly PackageManifest[]): string[][] {
  return findImportCycles(buildPackageGraph(manifests))
}
