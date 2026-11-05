import { folderNameRefusal } from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { TRASH_FOLDER_NAMES_MAX } from './workspace-trash.js'
import { walk } from './workspace-tree.js'

/**
 * Every named folder path, once, with the name it shows: the first NAMED
 * folder node at that path in tree order. Concurrent creation can leave two
 * folder nodes at one path, and either may be the one somebody named — so
 * the rule reads past an unnamed first node rather than letting it hide the
 * name, and every peer picks the same one because tree order is shared.
 */
export function readWorkspaceFolderNames(
  doc: LoroDoc,
): Array<{ readonly path: string; readonly name: string }> {
  const out: Array<{ readonly path: string; readonly name: string }> = []
  const seen = new Set<string>()
  for (const { read, path } of walk(doc)) {
    if (read.type !== 'folder' || read.name === undefined || seen.has(path)) continue
    seen.add(path)
    out.push({ path, name: read.name })
  }
  return out
}

/**
 * Names the folder at `path`, or clears its name when `name` is absent —
 * false, with nothing written, when no FOLDER node stands there (a document
 * used as a folder has no folder node to carry one).
 *
 * A set writes the first folder node in tree order; a clear deletes the name
 * from every folder node at the path, since a name left on a second node
 * would show again the moment the first one stopped being first. Stored
 * trimmed, and refused for what `folderNameRefusal` refuses. Whether the name
 * duplicates a sibling's is the caller's question (model's
 * `isSiblingDisplayNameTaken`): this writes what it is given.
 */
export function setWorkspaceFolderName(
  doc: LoroDoc,
  input: { readonly path: string; readonly name?: string },
): boolean {
  const refusal = input.name === undefined ? null : folderNameRefusal(input.name)
  if (refusal !== null) throw new Error(refusal)
  const name = input.name?.trim()
  const folders = walk(doc).filter(
    ({ read, path }) => read.type === 'folder' && path === input.path,
  )
  const first = folders[0]
  if (first === undefined) return false
  if (name === undefined) {
    for (const { node, read } of folders) {
      if (read.type === 'folder' && read.name !== undefined) node.data.delete('name')
    }
  } else {
    first.node.data.set('name', name)
  }
  doc.commit()
  return true
}

/**
 * The named folders above `path` among `named`, shallowest first: what a
 * trash row keeps so a restore can show them again. Looked up by prefix
 * rather than scanned, so a delete of many documents costs their depth each.
 */
export function namedFoldersAbove(
  named: ReadonlyMap<string, string>,
  path: string,
): Array<{ readonly path: string; readonly name: string }> {
  const out: Array<{ readonly path: string; readonly name: string }> = []
  const segments = path.split('/')
  for (let depth = 1; depth < segments.length; depth++) {
    const folder = segments.slice(0, depth).join('/')
    const name = named.get(folder)
    if (name !== undefined) out.push({ path: folder, name })
  }
  // A row holds a bounded list, and a path may nest past it; the nearest are
  // the names a restore shows first.
  return out.slice(-TRASH_FOLDER_NAMES_MAX)
}

/** Every named folder's name by path, read once from a record. */
export function folderNamesByPath(doc: LoroDoc): Map<string, string> {
  return new Map(readWorkspaceFolderNames(doc).map(({ path, name }) => [path, name]))
}

/**
 * Gives back the names a trash row kept, to the folders standing again and
 * showing none. A name a folder has been given since wins, and one the model
 * refuses (a row is synced data) is skipped rather than failing the restore.
 * Not checked against siblings: a duplicate that arrives by restore is kept,
 * never renamed.
 */
export function reapplyFolderNames(
  doc: LoroDoc,
  names: ReadonlyArray<{ readonly path: string; readonly name: string }>,
): void {
  const named = new Set(readWorkspaceFolderNames(doc).map((folder) => folder.path))
  for (const { path, name } of names) {
    if (named.has(path) || folderNameRefusal(name) !== null) continue
    setWorkspaceFolderName(doc, { path, name })
  }
}
