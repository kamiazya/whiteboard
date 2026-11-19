/**
 * The index's rules over what a workspace record holds, separate from where it
 * holds it: when a name or a path is taken, and the entry a port answers.
 */
import type { TrashEntry, WorkspaceNode } from '@kamiazya/whiteboard-loro-adapter'
import {
  displayNameKey,
  firstDistinctUnnamedPath,
  isSelfOrDescendant,
  movedDisplayNameTaken,
  siblingDisplayNameTaken,
} from '@kamiazya/whiteboard-model'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import { blobRefKey, DisplayNameTakenError } from '@kamiazya/whiteboard-ports'

/**
 * Whether a write keeps the name its target already shows. Such a write is
 * never refused as a duplicate: a sibling that merged in under the same name
 * is one this keeper could not have refused, and re-saving a form must not
 * fail over it.
 */
export function sameDisplayName(current: string | undefined, next: string): boolean {
  return current !== undefined && displayNameKey(current) === displayNameKey(next)
}

/**
 * Refuses `name` for the document at `path` when another document directly
 * under the same parent already shows it. `documentId` leaves the document
 * itself out, so keeping its own name is no duplicate.
 */
export function refuseSiblingDocumentName(
  nodes: readonly WorkspaceNode[],
  path: string,
  name: string,
  documentId?: string,
): void {
  const others = nodes.flatMap((node) =>
    node.type === 'document' && node.meta.documentId !== documentId
      ? [{ path: node.path, name: node.meta.name }]
      : [],
  )
  const shown = siblingDisplayNameTaken('document', others, { path, name })
  if (shown !== undefined) throw new DisplayNameTakenError('document', path, shown)
}

/**
 * Refuses a move that would leave the node at `from` showing, under its new
 * parent, a name a sibling of the same kind already shows. Only the root of
 * the moving subtree changes parent; everything below it keeps its siblings.
 */
export function refuseMovedName(
  nodes: readonly WorkspaceNode[],
  moving: readonly WorkspaceNode[],
  from: string,
  to: string,
): void {
  for (const root of moving.filter((node) => node.path === from)) {
    const kind = root.type
    const name = root.type === 'folder' ? root.name : root.meta.name
    const staying = nodes.flatMap((node) =>
      node.type === kind && !isSelfOrDescendant(node.path, from) && !emptiedBy(nodes, node, from)
        ? [{ path: node.path, name: node.type === 'folder' ? node.name : node.meta.name }]
        : [],
    )
    const shown = movedDisplayNameTaken(kind, staying, { from, to, name })
    if (shown !== undefined) throw new DisplayNameTakenError(kind, to, shown)
  }
}

/**
 * Whether moving `from` away leaves `node` — one of its ancestors — with no
 * document under it, so `pruneEmptyFolders` removes it with the move. Every
 * other ancestor stays, and shows its name beside the moved root like any
 * sibling: a document always stays, and so does a folder still holding one.
 */
function emptiedBy(nodes: readonly WorkspaceNode[], node: WorkspaceNode, from: string): boolean {
  if (node.type !== 'folder' || !isSelfOrDescendant(from, node.path)) return false
  return !nodes.some(
    (other) =>
      other.type === 'document' &&
      isSelfOrDescendant(other.path, node.path) &&
      !isSelfOrDescendant(other.path, from),
  )
}

/** The address an unnamed document takes so it does not read like a named sibling. */
export function distinctUnnamedPath(nodes: readonly WorkspaceNode[], path: string): string {
  const documents = nodes.flatMap((node) =>
    node.type === 'document' ? [{ path: node.path, name: node.meta.name }] : [],
  )
  const taken = new Set(nodes.map((node) => node.path))
  // Null only past a thousand suffixes: the requested address stands and the
  // path-taken rules answer for it.
  return firstDistinctUnnamedPath(path, documents, (each) => taken.has(each)) ?? path
}

/** Whether a purge or restore of `entry` must leave its bytes for another trash row. */
export function isNamedByAnotherRow(rows: readonly TrashEntry[], entry: TrashEntry): boolean {
  return rows.some(
    (row) => row.documentId !== entry.documentId && blobRefKey(row.blob) === blobRefKey(entry.blob),
  )
}

export function entryOf(found: {
  documentId: string
  path: string
  kind: DocumentEntry['kind']
  name?: string
  shadowed?: true
  createdAt?: number
  updatedAt?: number
  contentDigest: string
}): DocumentEntry {
  // A create and a content write stamp updatedAt; a rename or a move does
  // not, since neither edits the document. Falls back to createdAt for a
  // record written before timestamps landed in the node meta; absent for one
  // that predates both — the port leaves the field optional for exactly that
  // record.
  const stamp = found.updatedAt ?? found.createdAt
  return {
    documentId: found.documentId,
    path: found.path,
    ...(found.kind === undefined ? {} : { kind: found.kind }),
    ...(found.name === undefined ? {} : { name: found.name }),
    ...(found.shadowed === undefined ? {} : { shadowed: found.shadowed }),
    ...(stamp === undefined ? {} : { updatedAt: new Date(stamp).toISOString() }),
    // Always present from a tree-backed index: the tree holds the content, so
    // the digest is derived on the same read as the rest of the entry.
    contentDigest: found.contentDigest,
  }
}
