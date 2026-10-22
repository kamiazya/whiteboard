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

/**
 * What a screen reader announces for a document in a list: what it is
 * called, then what kind it is. Pictures, excerpts and badges are supporting
 * detail a surface exposes as a description, never as the name.
 */
export function documentAccessibleName(
  document: { readonly name?: string | null; readonly path: string; readonly kind?: string },
  rule: UnnamedLabelRule,
): string {
  const kind = document.kind === 'spatial' ? 'Canvas' : 'Markdown note'
  return `${documentLabel(document, rule)}, ${kind}`
}
