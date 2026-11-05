/**
 * The display names of the named folders a document at `path` sits in, top
 * down — what a document is found by beyond its own text, since a folder
 * renamed to "Operations Team" keeps its address and the address is all the
 * path says. An unnamed folder adds nothing: its segment is in the path
 * already.
 */
export function folderNamesOf(path: string, names: ReadonlyMap<string, string>): string[] {
  const found: string[] = []
  for (let cut = path.indexOf('/'); cut !== -1; cut = path.indexOf('/', cut + 1)) {
    const name = names.get(path.slice(0, cut))
    if (name !== undefined) found.push(name)
  }
  return found
}
