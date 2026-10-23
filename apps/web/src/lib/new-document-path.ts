import { pathBelow } from '@kamiazya/whiteboard-model'

/**
 * Where a new document goes when it is made from inside a folder.
 *
 * Numbering is per folder rather than per workspace: `design/untitled` and
 * `untitled` do not collide, so letting one push the other to `-2` would
 * make the counter jump for no reason a person could see.
 *
 * The name is not involved here: ADR-0008 measured deriving a path from a
 * display name and found every non-Latin title collapsing to `untitled-N`, and
 * ADR-0007's addendum retracted it. A path is chosen or it starts as
 * `untitled-N`; `pathAfterFirstRename` is the one place a name later gives a
 * still-generated path its address, and it leaves a name with no address alone.
 *
 * Its inverse is loro-adapter's `isGeneratedDocumentPath`, which every keeper
 * reads to decide whether a heading may still name a document; a property
 * beside this file holds the two to each other through that seeding.
 */
export function newDocumentPathIn(folder: string, existingPaths: readonly string[]): string {
  // Anchored at a segment boundary, so `design-system/untitled` is not
  // inside `design`. Descendants need no filtering of their own: what is
  // left of `design/notes/untitled` is `notes/untitled`, and no name this
  // function ever asks about contains a slash.
  const prefix = folder === '' ? '' : `${folder}/`
  const siblings = new Set(
    existingPaths.flatMap((path) => {
      const rest = pathBelow(folder, path)
      return rest === undefined ? [] : [rest]
    }),
  )

  if (!siblings.has('untitled')) return `${prefix}untitled`
  let n = 2
  while (siblings.has(`untitled-${n}`)) n++
  return `${prefix}untitled-${n}`
}

/**
 * Whether a path is one `newDocumentPathIn` chose rather than one a person
 * did — the last segment is `untitled` or `untitled-N` for N >= 2.
 *
 * It is the inverse the first rename reads to decide the address may still
 * follow the name. loro-adapter keeps its own copy for the heading-naming
 * gate; the property beside this file holds this one to the generator.
 */
export function isGeneratedPath(path: string): boolean {
  const last = path.slice(path.lastIndexOf('/') + 1)
  return /^untitled(?:-(?:[2-9]|[1-9]\d+))?$/.test(last)
}
