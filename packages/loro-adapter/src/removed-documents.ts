// Which documents a workspace import removed, with the bytes a trash row
// needs to bring each back — read off the record as it stood BEFORE the
// import, because a removed tree node cannot be revived and a shallow
// snapshot drops what it held.
import { isSelfOrDescendant } from '@kamiazya/whiteboard-model'
import type { LoroDoc, VersionVector } from 'loro-crdt'
import {
  deleteWorkspaceDocument,
  exportWorkspaceSubtree,
  readWorkspaceNodes,
  WORKSPACE_TREE_KEY,
} from './workspace-tree.js'

/** A document an import removed, exported as `exportWorkspaceSubtree` exports one for the trash. */
export interface RemovedDocument {
  readonly documentId: string
  /** Where it was before the import, for a trash listing a human can read. */
  readonly path: string
  /** Its subtree as it stood before the import: what a restore puts back. */
  readonly bytes: Uint8Array
}

interface PlacedDocument {
  readonly documentId: string
  readonly path: string
}

function placedDocuments(doc: LoroDoc): PlacedDocument[] {
  return readWorkspaceNodes(doc).flatMap((node) =>
    node.type === 'document' ? [{ documentId: node.meta.documentId, path: node.path }] : [],
  )
}

const isBelow = (path: string, ancestor: string) =>
  path !== ancestor && isSelfOrDescendant(path, ancestor)

/**
 * Every document live before `since`'s import and gone after it, exported
 * for the trash.
 *
 * Only an operation on the tree itself can take a document out — a delete,
 * or a move under a node a concurrent delete took — so an import with none
 * pays nothing beyond reading its operations once. One that has one pays a
 * fork of the record at `since`.
 *
 * A removed document below another removed document travels in its
 * ancestor's bytes, the way a restore brings a subtree back, and gets no
 * export of its own — unless a document between them survived (moved out by
 * the same import), since the ancestor's bytes leave a survivor out: a
 * restore would otherwise put a second copy of it back.
 */
export function documentsRemovedSince(workspace: LoroDoc, since: VersionVector): RemovedDocument[] {
  if (!treeChangedSince(workspace, since)) return []
  const alive = new Set(placedDocuments(workspace).map((each) => each.documentId))
  // Checked out on a fork rather than `forkAt`, which a shallow snapshot —
  // what compaction leaves a record as — refuses ("not implemented").
  // Detached editing, because the export below trims the scratch copy.
  const before = workspace.fork()
  before.checkout(workspace.vvToFrontiers(since))
  before.setDetachedEditing(true)
  const was = placedDocuments(before)
  const removed = was.filter((each) => !alive.has(each.documentId))
  if (removed.length === 0) return []
  const survivors = was.filter((each) => alive.has(each.documentId))
  const ridesAncestor = (placed: PlacedDocument) =>
    removed.some(
      (ancestor) =>
        isBelow(placed.path, ancestor.path) &&
        !survivors.some(
          (between) => isBelow(between.path, ancestor.path) && isBelow(placed.path, between.path),
        ),
    )
  return exportDeepestFirst(
    before,
    was,
    removed.filter((each) => !ridesAncestor(each)),
    survivors,
  )
}

function treeChangedSince(workspace: LoroDoc, since: VersionVector): boolean {
  const tree = workspace.getTree(WORKSPACE_TREE_KEY).id
  const { changes } = workspace.exportJsonUpdates(since, workspace.oplogVersion(), false)
  return changes.some((change) => change.ops.some((op) => op.container === tree))
}

/**
 * Each evacuee's subtree, exported from the scratch fork `before`, which is
 * trimmed as it goes so a path export picks the evacuee and only what it
 * should carry: survivors below it are cut, and so is a document ahead of it
 * in tree order at the same path (one a concurrent create shadowed it with).
 * Deepest first, so a cut never takes something not yet exported; at one
 * depth in tree order, so an owner is exported before the shadowed one cuts it.
 */
function exportDeepestFirst(
  before: LoroDoc,
  was: readonly PlacedDocument[],
  evacuees: readonly PlacedDocument[],
  survivors: readonly PlacedDocument[],
): RemovedDocument[] {
  const depth = (path: string) => path.split('/').length
  const order = [...evacuees].sort((left, right) => depth(right.path) - depth(left.path))
  const out: RemovedDocument[] = []
  for (const evacuee of order) {
    cutAround(before, evacuee, was, survivors)
    const bytes = exportWorkspaceSubtree(before, evacuee.path)
    if (bytes !== null) out.push({ ...evacuee, bytes })
  }
  return out
}

/** Cuts from `before` what an export of `evacuee` by path must not carry, or must not pick instead. */
function cutAround(
  before: LoroDoc,
  evacuee: PlacedDocument,
  was: readonly PlacedDocument[],
  survivors: readonly PlacedDocument[],
): void {
  for (const survivor of survivors) {
    if (isBelow(survivor.path, evacuee.path)) deleteWorkspaceDocument(before, survivor)
  }
  for (const ahead of was) {
    if (ahead.documentId === evacuee.documentId) return
    if (ahead.path === evacuee.path) deleteWorkspaceDocument(before, ahead)
  }
}
