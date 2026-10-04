/**
 * Code-unit order, the comparator `model`'s `compareCodeUnit` is.
 *
 * Restated rather than imported because this tool depends on the TypeScript
 * compiler alone: it reads the workspace packages' source and must not be
 * built from them. Two guards sort string keys with it, and a bare `.sort()`
 * reads as an oversight.
 */
export function compareCodeUnit(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}
