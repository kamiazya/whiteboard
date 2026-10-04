/**
 * What sits directly inside one folder.
 *
 * The middle pane of the browser shows ONE level, which is the whole
 * difference between it and the flat grid it replaces: a grandchild belongs
 * to the folder between them, not here.
 *
 * A folder is only ever a shared prefix in this model — there is no record
 * for one — so a folder's identity is the prefix itself and its name is the
 * last segment of it. That also means a document can be a folder at the same
 * time: `design` may exist while `design/login` does. It appears in BOTH
 * roles rather than the pane picking one, because both are true.
 */

export interface FolderChild {
  /** The prefix, which is the only identity a folder has. */
  readonly path: string
  /** Its last segment — a folder has no display name of its own. */
  readonly name: string
  /** How many documents live below it, at any depth. */
  readonly count: number
}

import { compareCodeUnit, pathBelow } from '@kamiazya/whiteboard-model'
import { compareDocumentEntries } from '../../lib/document-entry.js'

interface PathBearing {
  readonly path: string
  readonly pinOrder?: number
}

export function folderContents<T extends PathBearing>(
  documents: readonly T[],
  folder: string,
): { folders: readonly FolderChild[]; documents: readonly T[] } {
  const prefix = folder === '' ? '' : `${folder}/`
  const here: T[] = []
  const counts = new Map<string, number>()
  for (const entry of documents) {
    // Anchored at a segment boundary: `design-system` is not inside `design`,
    // and a folder's own document is not below itself.
    const rest = pathBelow(folder, entry.path)
    if (rest === undefined) continue
    const cut = rest.indexOf('/')
    if (cut === -1) {
      here.push(entry)
      continue
    }
    const name = rest.slice(0, cut)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const folders = [...counts.entries()]
    .map(([name, count]) => ({ path: `${prefix}${name}`, name, count }))
    .sort((left, right) => compareCodeUnit(left.name, right.name))

  return {
    folders,
    documents: here.sort(compareDocumentEntries),
  }
}
