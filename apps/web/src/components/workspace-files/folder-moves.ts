import { compareCodeUnit, isSelfOrDescendant, rebasePath } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { documentPathRefusal } from './document-path-refusal.js'

/** The folder a path sits in; `''` is the workspace root. */
export function folderOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

export function leafOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function joinPath(folder: string, leaf: string): string {
  return folder === '' ? leaf : `${folder}/${leaf}`
}

/**
 * Every folder the documents' paths name, ancestors included, in code-unit
 * order. A folder has no existence of its own, so this is the whole list a
 * person can move something into without making a new one.
 */
export function foldersOf(documents: readonly WorkspaceDocumentEntry[]): string[] {
  const folders = new Set<string>()
  for (const entry of documents) {
    const segments = entry.path.split('/').slice(0, -1)
    for (let i = 1; i <= segments.length; i++) folders.add(segments.slice(0, i).join('/'))
  }
  return [...folders].sort(compareCodeUnit)
}

/** Where a document lands when it is put in `folder`: same last segment, new parent. */
export function pathInFolder(documentPath: string, folder: string): string {
  return joinPath(folder, leafOf(documentPath))
}

/** The display of a folder path, with the root named as the workspace. */
export function folderLabel(folder: string): string {
  return folder === '' ? 'Workspace' : folder
}

/**
 * Why a folder name cannot be used under `parent`, or null. A name is ONE
 * segment: a slash would quietly nest, which is a different action from the
 * rename or subfolder the person asked for.
 */
export function folderNameRefusal(name: string, parent: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'Give the folder a name.'
  if (trimmed.includes('/')) return 'A folder name is one segment; it cannot contain “/”.'
  return documentPathRefusal(joinPath(parent, trimmed))
}

/** `path` after the folder `from` has been renamed to `to`; unchanged when it is elsewhere. */
export function pathAfterFolderMove(path: string, from: string, to: string): string {
  return isSelfOrDescendant(path, from) ? rebasePath(path, from, to) : path
}

/** What a person typed as a new folder, without the slashes that bracket it. */
export function typedFolderPath(typed: string): string {
  return typed
    .trim()
    .split('/')
    .filter((segment) => segment !== '')
    .join('/')
}
