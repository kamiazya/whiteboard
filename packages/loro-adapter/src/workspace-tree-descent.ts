import type { Container, ContainerID, LoroDoc } from 'loro-crdt'
import { WORKSPACE_TREE_KEY } from './workspace-tree.js'

const TREE_ROOT: ContainerID = `cid:root-${WORKSPACE_TREE_KEY}:Tree`

/**
 * How loro-crdt spells a mergeable child's id: a root id whose name opens with
 * this mark. Every other `cid:root-` id names an ordinary root.
 */
const MERGEABLE_CHILD_PREFIX = 'cid:root-\u{1F91D}:'

/**
 * Whether `container` is the workspace tree or sits anywhere below it — the
 * question every judge of "which document does this op belong to" asks first.
 *
 * A path cannot answer it. `getPathToContainer` names a root by its NAME
 * alone, so a Map, Text, List, MovableList or Counter root also called `tree`,
 * and everything under it, reads `['tree', …]` exactly as a document's content
 * does — a map under it keyed by a real node's id even reads as that node's.
 * The root's container id carries its kind, so the walk compares that.
 *
 * A container the doc cannot resolve answers false, so a judge built on this
 * fails closed. A node a delete took keeps its parent chain: its containers
 * still answer true.
 */
export function descendsFromWorkspaceTree(doc: LoroDoc, container: ContainerID): boolean {
  if (container === TREE_ROOT) return true
  // An ordinary root has no parent, so it is not below the tree, and it is
  // not looked up: resolving a root the doc lacks registers an empty one, and
  // this is a read. A mergeable child's id is a root id too, and only its
  // parent chain says where it sits; one the doc lacks resolves to nothing.
  if (container.startsWith('cid:root-') && !container.startsWith(MERGEABLE_CHILD_PREFIX)) {
    return false
  }
  let at: Container | undefined
  try {
    at = doc.getContainerById(container)
  } catch {
    return false
  }
  for (; at !== undefined; at = at.parent()) {
    if (at.id === TREE_ROOT) return true
  }
  return false
}
