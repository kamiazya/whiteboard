// Which documents a workspace import removed, with the bytes a trash row
// needs to bring each back — read off the record as it stood BEFORE the
// import, because a removed tree node cannot be revived and a shallow
// snapshot drops what it held.
import type { LoroDoc, TreeID, VersionVector } from 'loro-crdt'
import {
  deleteWorkspaceNode,
  exportWorkspaceNodeSubtree,
  type PlacedWorkspaceDocument,
  readPlacedWorkspaceDocuments,
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

/**
 * The documents a walk placed, indexed by path one segment at a time, so the
 * nearest proper ancestor path holding a document is found in one descent of
 * a path's own segments — where testing each prefix as a string re-reads the
 * path once per segment, which a client-chosen depth makes quadratic. Split
 * on `/` as a walk joins, so a segment holding a `/` is matched the way a
 * path string is.
 */
interface PathIndexNode {
  readonly children: Map<string, PathIndexNode>
  readonly documents: PlacedWorkspaceDocument[]
}

function pathIndex(documents: readonly PlacedWorkspaceDocument[]): PathIndexNode {
  const root: PathIndexNode = { children: new Map(), documents: [] }
  for (const each of documents) {
    let at = root
    for (const segment of each.path.split('/')) {
      let next = at.children.get(segment)
      if (next === undefined) {
        next = { children: new Map(), documents: [] }
        at.children.set(segment, next)
      }
      at = next
    }
    at.documents.push(each)
  }
  return root
}

/** The documents at the nearest proper ancestor path of `path` that holds any, nearest first. */
function nearestAncestorDocuments(
  index: PathIndexNode,
  path: string,
): readonly PlacedWorkspaceDocument[] {
  const segments = path.split('/')
  let nearest: readonly PlacedWorkspaceDocument[] = []
  let at: PathIndexNode | undefined = index
  for (let i = 0; i < segments.length - 1 && at !== undefined; i++) {
    at = at.children.get(segments[i] as string)
    if (at !== undefined && at.documents.length > 0) nearest = at.documents
  }
  return nearest
}

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
  const alive = new Set(readPlacedWorkspaceDocuments(workspace).map((each) => each.documentId))
  // Checked out on a fork rather than `forkAt`, which a shallow snapshot —
  // what compaction leaves a record as — refuses ("not implemented").
  // Detached editing, because the export below trims the scratch copy.
  const before = workspace.fork()
  before.checkout(workspace.vvToFrontiers(since))
  before.setDetachedEditing(true)
  const was = readPlacedWorkspaceDocuments(before)
  const removed = was.filter((each) => !alive.has(each.documentId))
  if (removed.length === 0) return []
  // A removed document rides an ancestor's bytes when the nearest document on
  // its parent chain is a removed one: a survivor nearer would sit between
  // them, and one farther up cannot. Read off the chain, not the path, since a
  // document on another branch may sit at the path above it and hold nothing.
  const rides = (placed: PlacedWorkspaceDocument) =>
    placed.above !== undefined && !alive.has(placed.above)
  return exportDeepestFirst(
    before,
    was,
    removed.filter((each) => !rides(each)),
    alive,
  )
}

function treeChangedSince(workspace: LoroDoc, since: VersionVector): boolean {
  const tree = workspace.getTree(WORKSPACE_TREE_KEY).id
  const { changes } = workspace.exportJsonUpdates(since, workspace.oplogVersion(), false)
  return changes.some((change) => change.ops.some((op) => op.container === tree))
}

/**
 * Each evacuee's subtree, exported from the scratch fork `before` by the node
 * the walk found it on, which is trimmed as it goes so an export carries only
 * what it should: survivors below an evacuee are cut. That is the whole cut —
 * an evacuee below another sits under a survivor, since one under a removed
 * document rides it, so cutting the survivor leaves it out of the shallower
 * export. Deepest first, so a cut never takes something not yet exported.
 */
function exportDeepestFirst(
  before: LoroDoc,
  was: readonly PlacedWorkspaceDocument[],
  evacuees: readonly PlacedWorkspaceDocument[],
  alive: ReadonlySet<string>,
): RemovedDocument[] {
  const depth = (path: string) => path.split('/').length
  const order = [...evacuees].sort((left, right) => depth(right.path) - depth(left.path))
  const below = survivorsByEvacuee(was, evacuees, alive)
  const out: RemovedDocument[] = []
  for (const evacuee of order) {
    for (const id of below.get(evacuee.path) ?? []) deleteWorkspaceNode(before, id)
    const bytes = exportWorkspaceNodeSubtree(before, evacuee.id)
    if (bytes !== null) out.push({ documentId: evacuee.documentId, path: evacuee.path, bytes })
  }
  return out
}

/**
 * Every survivor below an evacuee, indexed in one pass under the DEEPEST
 * evacuee path above it — the first export to reach it, since deeper ones run
 * first. A path is enough here, where it is not for riding: a path above a
 * survivor that belongs to another branch only cuts it early, and every
 * evacuee inside the survivor's subtree is deeper still, so already exported.
 */
function survivorsByEvacuee(
  was: readonly PlacedWorkspaceDocument[],
  evacuees: readonly PlacedWorkspaceDocument[],
  alive: ReadonlySet<string>,
): Map<string, TreeID[]> {
  const evacueeIndex = pathIndex(evacuees)
  const below = new Map<string, TreeID[]>()
  for (const each of was) {
    if (!alive.has(each.documentId)) continue
    const deepest = nearestAncestorDocuments(evacueeIndex, each.path)[0]
    if (deepest === undefined) continue
    const list = below.get(deepest.path)
    if (list === undefined) below.set(deepest.path, [each.id])
    else list.push(each.id)
  }
  return below
}
