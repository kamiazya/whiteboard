// Display-only sibling of deriveNewCanvasSlug: browser-local list rows have a
// display name and an opaque UUID, and the UUID is what the UI currently shows
// as the secondary line. This derives a slug-shaped label from the name
// instead. NOT persisted and NOT an identity — but it deliberately matches the
// daemon's validateSlug charset, so if display slugs are ever promoted to real
// slugs nothing has to re-derive.
export function deriveDisplaySlug(name: string | undefined, existing: readonly string[]): string {
  const base =
    (name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  const taken = new Set(existing)
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}
