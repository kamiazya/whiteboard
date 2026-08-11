// Naming-follows-creation sibling of deriveCopySlug: the icon-only "+"
// control creates a canvas with no typed name, so it needs a slug the
// server's validateSlug (letters/digits/hyphen only) always accepts.
export function deriveNewCanvasSlug(
  existingSlugs: ReadonlySet<string> | readonly string[],
): string {
  const existing = existingSlugs instanceof Set ? existingSlugs : new Set(existingSlugs)
  if (!existing.has('untitled')) return 'untitled'
  let n = 2
  while (existing.has(`untitled-${n}`)) n++
  return `untitled-${n}`
}
