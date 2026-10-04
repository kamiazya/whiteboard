/**
 * Code-unit order, the same comparator as `model`'s `compareCodeUnit`.
 *
 * Restated here rather than imported because this package may depend on zod
 * alone (architecture-map), and `model` is not zod. Ordering by `localeCompare`
 * would read the host's locale, so registries and payload keys built on it
 * would differ between machines holding identical input.
 */
export function compareCodeUnit(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}
