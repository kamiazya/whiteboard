import { DOCUMENT_NAME_MAX_LENGTH, DOCUMENT_PATH_MAX_LENGTH } from './ids.js'

// What a duplicate is called and where it goes, decided once for both keepers:
// a copy lands BESIDE its source, so a person who keeps a folder tidy finds
// the copy in that folder whichever keeper holds the workspace.
//
// Both fill the first free number rather than advancing past the highest one
// seen, so a sequence with a renamed or deleted copy in it stays dense.
//
// Both hold the result to the bound its schema writes with. A base already at
// the bound is SHORTENED to make room for the suffix rather than refused: the
// title box lets a person type a name of exactly the bound, and a copy of it
// must not be the one write that then fails.

/** "Foo" -> "Foo (copy)" -> "Foo (copy 2)" -> ... */
export function deriveCopyName(
  baseName: string,
  existingNames: ReadonlySet<string> | readonly string[],
): string {
  const existing = existingNames instanceof Set ? existingNames : new Set(existingNames)
  const candidate = (suffix: string) =>
    `${fitName(baseName, DOCUMENT_NAME_MAX_LENGTH - suffix.length)}${suffix}`
  const first = candidate(' (copy)')
  if (!existing.has(first)) return first
  let n = 2
  while (existing.has(candidate(` (copy ${n})`))) n++
  return candidate(` (copy ${n})`)
}

/**
 * "notes/roadmap" -> "notes/roadmap-copy" -> "notes/roadmap-copy-2" -> ...
 *
 * Only the LAST segment changes, so the copy stays in its source's folder.
 * `null` when that folder leaves no room under `DOCUMENT_PATH_MAX_LENGTH` for
 * a copy segment at all — putting the copy anywhere else would be a placement
 * nobody asked for.
 */
export function deriveCopyPath(
  sourcePath: string,
  existingPaths: ReadonlySet<string> | readonly string[],
): string | null {
  const existing = existingPaths instanceof Set ? existingPaths : new Set(existingPaths)
  const cut = sourcePath.lastIndexOf('/') + 1
  const folder = sourcePath.slice(0, cut)
  const leaf = sourcePath.slice(cut)
  const candidate = (suffix: string): string | null => {
    const room = DOCUMENT_PATH_MAX_LENGTH - folder.length - suffix.length
    // A path segment must end in a letter or digit, so a cut that lands just
    // after a hyphen drops the hyphen too.
    const kept = leaf.slice(0, Math.max(0, room)).replace(/-+$/, '')
    return kept === '' ? null : `${folder}${kept}${suffix}`
  }
  let suffix = '-copy'
  for (let n = 2; ; n++) {
    const path = candidate(suffix)
    if (path === null || !existing.has(path)) return path
    suffix = `-copy-${n}`
  }
}

/** `name` cut to at most `max` UTF-16 units, never through a surrogate pair. */
function fitName(name: string, max: number): string {
  if (name.length <= max) return name
  const cut = name.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd()
}
