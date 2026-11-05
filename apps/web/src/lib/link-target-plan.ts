import { referenceMarkup } from '@kamiazya/whiteboard-codec'
import {
  deriveWorkspaceSegment,
  documentPathSchema,
  leafOfPath,
  parentOfPath,
} from '@kamiazya/whiteboard-model'
import { pathAfterFirstRename } from './first-rename-path.js'
import { newDocumentPathIn } from './new-document-path.js'

/** Where a note made from an unresolved link goes, what it is called, and how the link then reads. */
export interface LinkTargetPlan {
  readonly path: string
  readonly name: string
  readonly markup: string
}

/**
 * What creating a note for `[[text]]` does.
 *
 * The text is prose, so it becomes the DISPLAY name and the address is
 * derived the way the first rename derives one (`pathAfterFirstRename`), in
 * the linking document's folder unless the text names a folder itself. The
 * link is then written with that address and the text as its alias: the
 * reference resolves by path, and still reads as typed. Text that already is
 * an address stays the address.
 */
export function planLinkTarget(
  text: string,
  ownPath: string | undefined,
  existingPaths: readonly string[],
): LinkTargetPlan | null {
  const typed = text.trim()
  const typedFolder = parentOfPath(typed)
  const folderIsAddress = typedFolder !== '' && documentPathSchema.safeParse(typedFolder).success
  const ownParent = ownPath === undefined ? '' : parentOfPath(ownPath)
  const ownFolder = ownParent === '' ? '' : `${ownParent}/`
  const folder = folderIsAddress ? `${typedFolder}/` : ownFolder
  const name = (folderIsAddress ? leafOfPath(typed) : typed).trim()
  if (name === '') return null

  const path = isAddress(name)
    ? `${folder}${name}`
    : (pathAfterFirstRename(`${folder}untitled`, name, existingPaths) ??
      newDocumentPathIn(folder.slice(0, -1), existingPaths))
  if (!documentPathSchema.safeParse(path).success) return null
  const markup =
    referenceMarkup({ target: path, alias: name === path ? undefined : name }) ??
    referenceMarkup({ target: path })
  return markup === undefined ? null : { path, name, markup }
}

const isAddress = (text: string): boolean => deriveWorkspaceSegment(text) === text
