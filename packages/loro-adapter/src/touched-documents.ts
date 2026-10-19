// Which documents a workspace import wrote to, for a keeper that takes whole
// workspace updates: the update does not say which document it is about, and
// everything a keeper does per edited document — naming it after its heading,
// stamping when it was edited, checkpointing it — needs to know.
import type { ContainerID, LoroDoc, LoroTreeNode, TreeID, VersionVector } from 'loro-crdt'
import { isNodeMetaContainer } from './node-meta-containers.js'
import { WORKSPACE_TREE_KEY, workspaceNodeMetaSchema } from './workspace-tree.js'
import { descendsFromWorkspaceTree } from './workspace-tree-descent.js'

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
 * Where a container sits, judged once per container: `outside` for anything
 * not below the real workspace tree, else its path (`undefined` under a node
 * a delete took).
 */
function placesOf(workspace: LoroDoc) {
  const places = new Map<ContainerID, readonly (string | number)[] | undefined | 'outside'>()
  return (container: ContainerID) => {
    if (!places.has(container)) {
      places.set(
        container,
        descendsFromWorkspaceTree(workspace, container)
          ? workspace.getPathToContainer(container)
          : 'outside',
      )
    }
    return places.get(container)
  }
}

/**
 * The tree node each operation after `since` landed under, and whether any of
 * them wrote its content. A node's own map sits at `[tree, <node>]` and every
 * content container one level further down; anything else in the record is no
 * document's.
 */
function nodesWritten(workspace: LoroDoc, since: VersionVector): Map<TreeID, boolean> {
  const content = new Map<TreeID, boolean>()
  const placeOf = placesOf(workspace)
  const { changes } = workspace.exportJsonUpdates(since, workspace.oplogVersion(), false)
  for (const op of changes.flatMap((change) => change.ops)) {
    const path = placeOf(op.container)
    if (path === 'outside' || path === undefined || path.length < 2) continue
    // Below the real tree, the second segment is always a node's id.
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

// The node-map keys that say WHICH document a node is and where it sits; a
// write to any other key (content, display name, edit stamps) leaves the
// workspace holding the same documents at the same paths.
const PLACEMENT_KEYS: ReadonlySet<string> = new Set(['documentId', 'segment', 'kind'])

/**
 * Whether the operations after `since` change how the workspace is organised
 * rather than what its documents say: a node created, deleted or moved in the
 * tree, a node's identity, segment or kind rewritten, or ANY write outside the
 * tree — the trash, the pinned list and the rest of the workspace's own meta,
 * or a root nobody reads. Content, display names and edit stamps answer false.
 *
 * Outside the tree is judged whole rather than by naming the trash and the
 * pins, because nothing a document says lives there: a root added to the
 * record tomorrow is the workspace's, and is held to the same grant from the
 * day it exists.
 *
 * What a keeper asks of an update from a caller entitled to edit content but
 * not to add, remove or move documents, purge or restore the trash, or pin.
 */
export function organisationChangedSince(workspace: LoroDoc, since: VersionVector): boolean {
  const tree = workspace.getTree(WORKSPACE_TREE_KEY).id
  const placeOf = placesOf(workspace)
  const { changes } = workspace.exportJsonUpdates(since, workspace.oplogVersion(), false)
  return changes
    .flatMap((change) => change.ops)
    .some((op) => {
      if (op.container === tree) return true
      const path = placeOf(op.container)
      if (path === 'outside') return true
      // No path at all is a container under a node a delete took: judged as
      // the tree's, by the placement keys below, as it always was.
      // Inside a container held at a meta key: a reader refuses the node, and
      // an edit there could rename or re-place it from below the node's map.
      if (path !== undefined && path.length > 2 && isNodeMetaContainer(path, op.container)) {
        return true
      }
      const content = op.content as { readonly key?: unknown }
      if (typeof content.key !== 'string' || !PLACEMENT_KEYS.has(content.key)) return false
      return path?.length === 2
    })
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
