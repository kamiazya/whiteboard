// Slug-safe sibling of deriveCopyName: daemon canvas slugs are restricted to
// ASCII letters, digits, and hyphens (see validateSlug on the server), so the
// "(copy)" / "(copy N)" display-name suffix can't be reused verbatim here.
export function deriveCopySlug(
  baseSlug: string,
  existingSlugs: ReadonlySet<string> | readonly string[],
): string {
  const existing = existingSlugs instanceof Set ? existingSlugs : new Set(existingSlugs)
  const first = `${baseSlug}-copy`
  if (!existing.has(first)) return first
  let n = 2
  while (existing.has(`${baseSlug}-copy-${n}`)) n++
  return `${baseSlug}-copy-${n}`
}
