import {
  displayNameKey,
  folderNameRefusal,
  leafOfPath,
  parentOfPath,
} from '@kamiazya/whiteboard-model'
import { addressForNameIn } from './address-from-name.js'
import { displayNameTakenMessage } from './display-name-taken.js'

/** What a folder is called on screen, by path: only the NAMED folders are in it. */
export type FolderNames = ReadonlyMap<string, string>

const NO_NAMES: FolderNames = new Map()

/**
 * What a folder is called: the name somebody gave it, or its own segment when
 * nobody did. The root is the workspace, which no folder name can rename.
 */
export function folderDisplayName(path: string, names: FolderNames = NO_NAMES): string {
  if (path === '') return 'Workspace'
  return names.get(path) ?? leafOfPath(path)
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
function newFolderSegmentIn(parent: string, name: string, taken: readonly string[]): string {
  return addressForNameIn(parent, name, 'folder', taken)
}

/**
 * The folder among `folders` that already shows `name` beside `target.path`
 * — each showing its name from `names` or its segment — or undefined. The
 * folder itself is left out, so keeping its own name is never a duplicate.
 * Documents are a different kind and are not compared.
 */
export function folderShowingName(
  folders: readonly string[],
  names: FolderNames,
  target: { readonly path: string; readonly name: string },
): string | undefined {
  const parent = parentOfPath(target.path)
  const key = displayNameKey(target.name)
  return folders.find(
    (path) =>
      path !== target.path &&
      parentOfPath(path) === parent &&
      displayNameKey(folderDisplayName(path, names)) === key,
  )
}

/**
 * The refusal of a name the folder at `existing` already shows: quoted as
 * that folder is CALLED, not as it was typed — "q3 planning" beside a folder
 * called "Q3 Planning" read as a claim that something is called the former —
 * and placed by its parent's names when it is not at the top.
 */
export function folderNameTakenMessage(existing: string, names: FolderNames): string {
  const parent = parentOfPath(existing)
  if (parent === '')
    return displayNameTakenMessage('folder', existing, folderDisplayName(existing, names))
  const where = folderTrail(parent, names).join(' / ')
  return (
    `Another folder in "${where}" is already called "${folderDisplayName(existing, names)}". ` +
    'Choose a name no other folder there has.'
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
 * one folder, named by that part, starting under `known.from` (the root when
 * absent). A part that names a folder already standing
 * under the same parent — by what it is called or by its address — is that
 * folder, the last part included: typing a folder that exists is asking to go
 * there, so the plan answers it and makes nothing. Each new address is derived
 * from its part, numbered past whatever `taken` and the earlier parts hold.
 */
export function planNestedFolder(
  typed: string,
  known: {
    readonly folders: readonly string[]
    readonly names: FolderNames
    readonly taken: readonly string[]
    readonly from?: string
  },
): NestedFolderPlan {
  const parts = typed
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return { refusal: folderNameRefusal('') ?? '' }
  let parent = known.from ?? ''
  const created: { path: string; name: string }[] = []
  for (const part of parts) {
    const refusal = folderNameRefusal(part)
    if (refusal !== null) return { refusal }
    const key = displayNameKey(part)
    const existing = known.folders.find(
      (path) =>
        parentOfPath(path) === parent &&
        (displayNameKey(folderDisplayName(path, known.names)) === key ||
          displayNameKey(leafOfPath(path)) === key),
    )
    if (existing !== undefined) {
      parent = existing
      continue
    }
    parent = newFolderSegmentIn(parent, part, [...known.taken, ...created.map((each) => each.path)])
    created.push({ path: parent, name: part })
  }
  return { path: parent, created }
}

/**
 * A typed folder planned for New folder, which MAKES one: the same nesting as
 * `planNestedFolder`, but a path whose every part already stands makes
 * nothing, so it is the duplicate refusal of the last folder on it rather than
 * a quiet visit there.
 */
export function planFolderToCreate(
  typed: string,
  known: Parameters<typeof planNestedFolder>[1],
): NestedFolderPlan {
  const plan = planNestedFolder(typed, known)
  if ('refusal' in plan || plan.created.length > 0) return plan
  return { refusal: folderNameTakenMessage(plan.path, known.names) }
}
