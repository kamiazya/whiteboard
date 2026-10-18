import { NODE_META_KEYS, WORKSPACE_TREE_KEY } from './workspace-tree.js'

/**
 * Whether the container at `path` (`doc.getPathToContainer`) is a tree node's
 * own map or sits anywhere inside a container held at one of its meta keys —
 * a write to either is a write of node meta. A content container sits at
 * `[tree, node, <content key>]`, which never names a meta key.
 *
 * A reader refuses a node holding a meta key as a container, whatever the
 * container projects to (`readMeta`), because an edit inside one lands below
 * the node's own map, where content edits land: a judge that recognised meta
 * writes by the map alone would let a caller entitled to edit content only
 * rename, blank or re-place the node from there. This is the same rule for a
 * judge reading operations.
 */
export function isNodeMetaContainer(
  path: readonly (string | number)[] | undefined,
  container: string,
): boolean {
  if (path === undefined || path[0] !== WORKSPACE_TREE_KEY) return false
  if (path.length === 2) return container.endsWith(':Map')
  return path.length > 2 && NODE_META_KEYS.has(String(path[2]))
}
