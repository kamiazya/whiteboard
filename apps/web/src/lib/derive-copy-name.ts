// Deterministic "Duplicate" naming shared by both duplicate surfaces
// (browser-local canvas controller, daemon index gallery): "Foo" -> "Foo
// (copy)" -> "Foo (copy 2)" -> ... Fills a gap left by a renamed/deleted
// numbered copy instead of always advancing past the highest number seen, so
// the sequence stays dense from the caller's point of view.
export function deriveCopyName(
  baseName: string,
  existingNames: ReadonlySet<string> | readonly string[],
): string {
  const existing = existingNames instanceof Set ? existingNames : new Set(existingNames)
  const first = `${baseName} (copy)`
  if (!existing.has(first)) return first
  let n = 2
  while (existing.has(`${baseName} (copy ${n})`)) n++
  return `${baseName} (copy ${n})`
}
