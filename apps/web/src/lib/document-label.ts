import { shownName } from '@kamiazya/whiteboard-model'

/**
 * Which stand-in an unnamed document shows: the last segment of its path, or
 * the whole path. Each surface picks one for itself — a row inside a folder
 * already shows the folder, a flat list or a confirmation does not.
 */
export type UnnamedLabelRule = 'leaf' | 'path'

/**
 * What a document is CALLED on a surface: its chosen name, or — when it has
 * none — a stand-in derived from its path by `rule`. The `leaf` rule is
 * model's `shownName`, what every keeper's sibling rule compares, so a row
 * reads exactly as the name a refusal quotes for it.
 *
 * Unnamed is spelled by absence (`null` or omitted), as both keepers' index
 * stores it, and a blank name reads as none. A name that happens to equal the
 * path is still a name somebody chose, so nothing here compares the two.
 */
export function documentLabel(
  document: { readonly name?: string | null; readonly path: string },
  rule: UnnamedLabelRule,
): string {
  if (rule === 'leaf') return shownName('document', document)
  return document.name?.trim() || document.path
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
