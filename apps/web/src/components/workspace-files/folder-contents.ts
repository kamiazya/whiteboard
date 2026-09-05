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
  // Anchored at a segment boundary: `design-system` starts with `design` and
  // is not inside it.
  const inside = documents.filter((entry) => folder === '' || entry.path.startsWith(prefix))

  const here: T[] = []
  const counts = new Map<string, number>()
  for (const entry of inside) {
    // A folder's own document is already excluded: `design` does not start
    // with `design/`, so the boundary filter above drops it before here.
    const rest = entry.path.slice(prefix.length)
    const cut = rest.indexOf('/')
    if (cut === -1) {
      here.push(entry)
      continue
    }
    const child = `${prefix}${rest.slice(0, cut)}`
    counts.set(child, (counts.get(child) ?? 0) + 1)
  }

  const folders = [...counts.entries()]
    .map(([path, count]) => ({ path, name: path.slice(prefix.length), count }))
    .sort((left, right) => left.name.localeCompare(right.name))

  return {
    folders,
    documents: here.sort(compareDocumentEntries),
  }
}
