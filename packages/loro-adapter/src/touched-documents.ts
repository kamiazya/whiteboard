// Which documents a workspace import wrote to, for a keeper that takes whole
// workspace updates: the update does not say which document it is about, and
// everything a keeper does per edited document — naming it after its heading,
// stamping when it was edited, checkpointing it — needs to know.
import type { ContainerID, LoroDoc, LoroTreeNode, TreeID, VersionVector } from 'loro-crdt'
import { WORKSPACE_TREE_KEY, workspaceNodeMetaSchema } from './workspace-tree.js'

/** A document an import wrote to. */
export interface TouchedDocument {
  readonly documentId: string
  /** The tree node holding it: coming back to it by id is a lookup, by `documentId` a walk. */
  readonly node: TreeID
  /** Derived from ancestry as of the import, as every listing derives it. */
  readonly path: string
  /**
   * Whether an operation landed INSIDE one of the document's content
   * containers, rather than only on its node's own map — meta (placement,
   * naming, timestamps) and the attaching of a still-empty container. A
   * rename is a write to the node, and is not an edit of the document.
   */
  readonly contentWritten: boolean
}

function pathOf(node: LoroTreeNode): string | null {
  const segments: string[] = []
  for (let at: LoroTreeNode | undefined = node; at !== undefined; at = at.parent()) {
    const segment = at.data.get('segment')
    if (typeof segment !== 'string') return null
    segments.unshift(segment)
  }
  return segments.join('/')
}

/**
 * The tree node each operation after `since` landed under, and whether any of
 * them wrote its content. A node's own map sits at `[tree, <node>]` and every
 * content container one level further down; anything else in the record is no
 * document's.
 */
function nodesWritten(workspace: LoroDoc, since: VersionVector): Map<TreeID, boolean> {
  const content = new Map<TreeID, boolean>()
  const paths = new Map<ContainerID, readonly (string | number)[] | undefined>()
  const pathTo = (container: ContainerID) => {
    if (!paths.has(container)) paths.set(container, workspace.getPathToContainer(container))
    return paths.get(container)
  }
  const { changes } = workspace.exportJsonUpdates(since, workspace.oplogVersion(), false)
  for (const op of changes.flatMap((change) => change.ops)) {
    const path = pathTo(op.container)
    if (path === undefined || path.length < 2 || path[0] !== WORKSPACE_TREE_KEY) continue
    const node = path[1] as TreeID
    content.set(node, content.get(node) === true || path.length > 2)
  }
  return content
}

/**
 * Every document the operations after `since` wrote to, skipping one the same
 * operations deleted.
 *
 * Read off the operations rather than the tree, so the cost follows the
 * update: a walk of the tree reads every document's content, which on a large
 * workspace is a per-keystroke cost the bytes did not ask for.
 *
 * `contentWritten` is the rule `writeWorkspaceDocumentContent` stamps by — a
 * write inside a content container; attaching an empty one is not a change —
 * applied to operations a replica wrote instead of ones this keeper did. An operation another one concurrently
 * outranked still counts: the document was edited, whichever edit the merge
 * kept.
 */
export function documentsTouchedSince(workspace: LoroDoc, since: VersionVector): TouchedDocument[] {
  const tree = workspace.getTree(WORKSPACE_TREE_KEY)
  const touched: TouchedDocument[] = []
  for (const [id, contentWritten] of nodesWritten(workspace, since)) {
    const node = tree.getNodeByID(id)
    if (node === undefined || node.isDeleted()) continue
    const documentId = node.data.get('documentId')
    const path = pathOf(node)
    if (typeof documentId !== 'string' || path === null) continue
    touched.push({ documentId, node: id, path, contentWritten })
  }
  return touched
}

/**
 * Stamps `updatedAt` on every touched document whose content was written,
 * and commits — the edit clock a listing reads, moved by an import the way
 * `writeWorkspaceDocumentContent` moves it for a keeper's own write. A
 * document only renamed or moved keeps its stamp, and with none to stamp
 * nothing is written.
 */
export function stampEditedDocuments(
  workspace: LoroDoc,
  touched: readonly TouchedDocument[],
  at: number = Date.now(),
): void {
  const tree = workspace.getTree(WORKSPACE_TREE_KEY)
  const stamp = workspaceNodeMetaSchema.shape.updatedAt.parse(at)
  for (const { node, contentWritten } of touched) {
    if (contentWritten) tree.getNodeByID(node)?.data.set('updatedAt', stamp)
  }
  workspace.commit()
}
