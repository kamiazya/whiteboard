/**
 * Where a new document goes when it is made from inside a folder.
 *
 * Numbering is per folder rather than per workspace: `design/untitled` and
 * `untitled` do not collide, so letting one push the other to `-2` would
 * make the counter jump for no reason a person could see.
 *
 * The name is not involved and never will be — ADR-0008 measured deriving a
 * path from a display name and found every non-Latin title collapsing to
 * `untitled-N`, and ADR-0007's addendum retracted it. A path is chosen or it
 * stays `untitled-N`; it is never guessed from what the document is called.
 */
export function newDocumentPathIn(folder: string, existingPaths: readonly string[]): string {
  // Anchored at a segment boundary, so `design-system/untitled` is not
  // inside `design`. Descendants need no filtering of their own: what is
  // left of `design/notes/untitled` is `notes/untitled`, and no name this
  // function ever asks about contains a slash.
  const prefix = folder === '' ? '' : `${folder}/`
  const siblings = new Set(
    existingPaths
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length)),
  )

  if (!siblings.has('untitled')) return `${prefix}untitled`
  let n = 2
  while (siblings.has(`untitled-${n}`)) n++
  return `${prefix}untitled-${n}`
}

/**
 * Whether a path is one this function chose, rather than one a person did.
 *
 * The pair matters because "nobody has named this yet" is not something the
 * tree records: clearing a name in the rename dialog leaves the same absent
 * `name` a brand-new document has. A still-generated path is the closest
 * honest proxy — someone who cleared the name of a document they had also
 * placed somewhere has engaged with naming, and must not be overridden.
 */
export function isGeneratedDocumentPath(path: string): boolean {
  const last = path.slice(path.lastIndexOf('/') + 1)
  return /^untitled(?:-(?:[2-9]|[1-9]\d+))?$/.test(last)
}

/**
 * The paths a new document must number around, for the two callers where a
 * failed read must not dead-end the user: the list page's create button and
 * the editor's first-boot create.
 *
 * A broken list read is exactly when the create path matters most, so an
 * unreadable store numbers from nothing rather than throwing. The store's own
 * uniqueness check is still behind this: the worst case is a refused create
 * that surfaces as the ordinary create-failed message, not two documents at
 * one address.
 */
export async function takenPathsIn(store: {
  listDocuments(): Promise<readonly { path: string }[]>
}): Promise<string[]> {
  try {
    return (await store.listDocuments()).map((row) => row.path)
  } catch {
    return []
  }
}
