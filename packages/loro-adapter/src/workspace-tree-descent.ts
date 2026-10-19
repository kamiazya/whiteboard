import type { Container, ContainerID, LoroDoc } from 'loro-crdt'
import { WORKSPACE_TREE_KEY } from './workspace-tree.js'

const TREE_ROOT: ContainerID = `cid:root-${WORKSPACE_TREE_KEY}:Tree`

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
  // No shortcut on a `cid:root-` prefix: a mergeable child container's id
  // carries one too, and only its parent chain says where it sits.
  if (container === TREE_ROOT) return true
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
