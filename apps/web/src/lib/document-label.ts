/**
 * Which stand-in an unnamed document shows: the last segment of its path, or
 * the whole path. Each surface picks one for itself — a row inside a folder
 * already shows the folder, a flat list or a confirmation does not.
 */
export type UnnamedLabelRule = 'leaf' | 'path'

/**
 * What a document is CALLED on a surface: its chosen name, or — when it has
 * none — a stand-in derived from its path by `rule`.
 *
 * Unnamed is spelled by absence (`null` or omitted), as both keepers' index
 * stores it. A name that happens to equal the path is still a name somebody
 * chose, so nothing here compares the two.
 */
export function documentLabel(
  document: { readonly name?: string | null; readonly path: string },
  rule: UnnamedLabelRule,
): string {
  if (document.name !== null && document.name !== undefined) return document.name
  if (rule === 'path') return document.path
  return document.path.slice(document.path.lastIndexOf('/') + 1)
}
