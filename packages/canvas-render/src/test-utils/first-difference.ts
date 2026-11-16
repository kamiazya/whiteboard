/**
 * The path to the first value two answers part at, or undefined when they
 * agree. A key holding `undefined` reads as absent, as it would to anyone
 * reading the scene, every number is compared with `Object.is`, and key order
 * is no part of an answer.
 */
export function firstDifference(a: unknown, b: unknown, at = ''): string | undefined {
  if (Object.is(a, b)) return undefined
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return at
  if (Array.isArray(a) !== Array.isArray(b)) return at
  const keys = (o: object) =>
    Object.entries(o).flatMap(([key, value]) => (value === undefined ? [] : [key]))
  for (const key of new Set([...keys(a), ...keys(b)])) {
    const found = firstDifference(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      `${at}/${key}`,
    )
    if (found !== undefined) return found
  }
  return undefined
}
