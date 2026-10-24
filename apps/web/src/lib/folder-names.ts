import {
  deriveWorkspaceSegment,
  displayNameKey,
  documentPathSchema,
  folderNameRefusal,
  isSiblingDisplayNameTaken,
  pathBelow,
} from '@kamiazya/whiteboard-model'
import { displayNameTakenMessage } from './display-name-taken.js'

/** What a folder is called on screen, by path: only the NAMED folders are in it. */
export type FolderNames = ReadonlyMap<string, string>

const NO_NAMES: FolderNames = new Map()

function leafOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * What a folder is called: the name somebody gave it, or its own segment when
 * nobody did. The root is the workspace, which no folder name can rename.
 */
export function folderDisplayName(path: string, names: FolderNames = NO_NAMES): string {
  if (path === '') return 'Workspace'
  return names.get(path) ?? leafOf(path)
}

/** Each folder from the top down to `path`, as it is called — the root not included. */
export function folderTrail(path: string, names: FolderNames = NO_NAMES): string[] {
  if (path === '') return []
  const segments = path.split('/')
  return segments.map((_, i) => folderDisplayName(segments.slice(0, i + 1).join('/'), names))
}

/**
 * The address a NEW folder called `name` gets under `parent`.
 *
 * Derived once, at creation, by the workspace segment rule, and never again:
 * the address is what links and the URL carry, so renaming the folder later
 * changes only what it is called. A name the segment charset cannot spell
 * (a script other than Latin, say) is still a name — the address falls back
 * to `folder` rather than refusing it. Numbered from `-2` past every sibling
 * `taken` holds, documents included, since a document's path is an address
 * a folder may not reuse.
 */
export function newFolderSegmentIn(parent: string, name: string, taken: readonly string[]): string {
  // The segment directly under `parent` of every path below it: a document
  // there holds its own address, and one deeper holds its folder's.
  const siblings = new Set(
    taken.flatMap((path) => {
      const rest = pathBelow(parent, path)
      return rest === undefined ? [] : [rest.split('/')[0] ?? rest]
    }),
  )
  const derived = deriveWorkspaceSegment(name) ?? 'folder'
  const base = documentPathSchema.safeParse(joinFolder(parent, derived)).success
    ? derived
    : 'folder'
  let leaf = base
  for (let n = 2; siblings.has(leaf); n++) leaf = `${base}-${n}`
  return joinFolder(parent, leaf)
}

function joinFolder(parent: string, leaf: string): string {
  return parent === '' ? leaf : `${parent}/${leaf}`
}

/**
 * Whether a folder at `path` may be called `name` among `folders` — the folder
 * paths known here, each showing its name from `names` or its segment. The
 * folder itself is left out, so keeping its own name is never a duplicate.
 * Documents are a different kind and are not compared.
 */
export function isFolderNameTaken(
  folders: readonly string[],
  names: FolderNames,
  target: { readonly path: string; readonly name: string },
): boolean {
  return isSiblingDisplayNameTaken(
    folders
      .filter((path) => path !== target.path)
      .map((path) => ({ path, name: folderDisplayName(path, names) })),
    target,
  )
}

/** A typed folder, planned: where it lands, and the folders it makes on the way, each named. */
export type NestedFolderPlan =
  | {
      readonly path: string
      readonly created: readonly { readonly path: string; readonly name: string }[]
    }
  | { readonly refusal: string }

/**
 * What "Class/Week 6" typed as a new folder means: `/` nests, so each part is
 * one folder, named by that part. A part that names a folder already standing
 * under the same parent is that folder — the way there — except the LAST one,
 * which is the folder being made, and making one a sibling already shows is a
 * known duplicate. Each new address is derived from its part, numbered past
 * whatever `taken` and the earlier parts hold.
 */
export function planNestedFolder(
  typed: string,
  known: {
    readonly folders: readonly string[]
    readonly names: FolderNames
    readonly taken: readonly string[]
  },
): NestedFolderPlan {
  const parts = typed
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return { refusal: folderNameRefusal('') ?? '' }
  let parent = ''
  const created: { path: string; name: string }[] = []
  for (const [i, part] of parts.entries()) {
    const refusal = folderNameRefusal(part)
    if (refusal !== null) return { refusal }
    const existing = known.folders.find(
      (path) =>
        parentOf(path) === parent &&
        displayNameKey(folderDisplayName(path, known.names)) === displayNameKey(part),
    )
    if (existing !== undefined && i === parts.length - 1) {
      return { refusal: displayNameTakenMessage('folder', existing, part) }
    }
    if (existing !== undefined) {
      parent = existing
      continue
    }
    parent = newFolderSegmentIn(parent, part, [...known.taken, ...created.map((each) => each.path)])
    created.push({ path: parent, name: part })
  }
  return { path: parent, created }
}
