import { compareCodeUnit } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'

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
