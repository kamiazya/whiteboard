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
 * Its inverse is model's `isGeneratedDocumentPath`, which every keeper reads
 * to decide whether a heading may still name a document and what an unnamed
 * one reads as; properties beside this file hold the two to each other.
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
