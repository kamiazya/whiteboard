// The type-inclusive half of the circular-import check. cycle-check.ts counts
// value edges only, because a value cycle is the one that fails at load; a
// cycle closed by `import type` is erased at emit and never fails anything.
// It is still a cycle in what a reader and a refactor can see: two modules
// that cannot be understood, moved or tested apart, and a "leaf" contract that
// is not a leaf. package-canvas-render.md's decision 14 says the references
// directory owns the seam types, and a layout module that owned one of them
// while importing the seams by value is exactly the knot this finds.
//
// Filesystem-free like cycle-check.ts: pure functions over supplied contents.

import {
  buildTypeInclusiveImportGraph,
  buildValueImportGraph,
  findImportCycles,
  type PathAliases,
} from './cycle-check.js'

/**
 * Every strongly connected component of the import graph WITH type edges,
 * except one the value-only scan already reports with exactly the same
 * members — that one is KNOWN_IMPORT_CYCLES's, and listing it in both ledgers
 * would make paying it off a two-place edit. A component that is a value cycle
 * widened by type-only members is still reported here, since it is a
 * different, larger knot than the one the value scan names.
 */
export function findTypeOnlyCycles(
  files: readonly { path: string; text: string }[],
  aliases: PathAliases = {},
): string[][] {
  const valueKeys = new Set(
    findImportCycles(buildValueImportGraph(files, aliases)).map((group) => group.join('|')),
  )
  return findImportCycles(buildTypeInclusiveImportGraph(files, aliases)).filter(
    (group) => !valueKeys.has(group.join('|')),
  )
}
