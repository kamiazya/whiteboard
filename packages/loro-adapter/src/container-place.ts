import { type ContainerID, type LoroDoc, LoroText, type TreeID } from 'loro-crdt'
import { holdsContainerCreation } from './sync-structure-limits.js'
import { readWorkspaceDocuments, WORKSPACE_TREE_KEY } from './workspace-tree.js'
import { descendsFromWorkspaceTree } from './workspace-tree-descent.js'

/** Where a record places a container: the document it belongs to, and that document's path. */
interface ContainerPlace {
  readonly documentId: string
  readonly path: string
  /** A text container's length in UTF-16 units; absent for any other container. */
  readonly textLength?: number
}

/**
 * The document of a workspace record `container` belongs to, or `null` when it
 * belongs to none the record lists: a root outside the tree, a folder's own
 * containers, a document since deleted, and a container whose creating
 * operation the record lacks, which has no parent (asking the engine for its
 * path panics rather than answering `undefined`, so it is not asked).
 *
 * A path cannot say whether a container sits below the tree, so the descent
 * check comes first: a root of another kind also named `tree` shares the
 * tree's path, and the segment after it is then no node id.
 */
export function containerPlace(doc: LoroDoc, container: ContainerID): ContainerPlace | null {
  if (!holdsContainerCreation(doc, container)) return null
  if (!descendsFromWorkspaceTree(doc, container)) return null
  const path = doc.getPathToContainer(container)
  if (path === undefined || path.length < 2) return null
  const node = doc.getTree(WORKSPACE_TREE_KEY).getNodeByID(path[1] as TreeID)
  const documentId = node?.data.get('documentId')
  const entry = readWorkspaceDocuments(doc).find((each) => each.documentId === documentId)
  if (entry === undefined) return null
  const held = doc.getContainerById(container)
  return {
    documentId: entry.documentId,
    path: entry.path,
    ...(held instanceof LoroText && { textLength: held.length }),
  }
}
