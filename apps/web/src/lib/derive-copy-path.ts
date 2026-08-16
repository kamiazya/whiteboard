// Path-safe sibling of deriveCopyName: a daemon document path is restricted to
// ASCII letters, digits, and hyphens (see validateSlug on the server), so the
// "(copy)" / "(copy N)" display-name suffix can't be reused verbatim here.
export function deriveCopySlug(
  baseSegment: string,
  existingSlugs: ReadonlySet<string> | readonly string[],
): string {
  const existing = existingSlugs instanceof Set ? existingSlugs : new Set(existingSlugs)
  const first = `${baseSegment}-copy`
  if (!existing.has(first)) return first
  let n = 2
  while (existing.has(`${baseSegment}-copy-${n}`)) n++
  return `${baseSegment}-copy-${n}`
}
