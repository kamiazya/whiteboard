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
  // A removed document rides an ancestor's bytes when the nearest document
  // above it is a removed one: a survivor nearer would sit between them, and
  // one farther up cannot.
  const index = pathIndex(was)
  const rides = (placed: PlacedWorkspaceDocument) =>
    nearestAncestorDocuments(index, placed.path).some((each) => !alive.has(each.documentId))
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
 * what it should: survivors below an evacuee are cut, and so is a document
 * ahead of it in tree order at the same path (one a concurrent create
 * shadowed it with), so no shallower export carries that one either. Deepest
 * first, so a cut never takes something not yet exported; at one depth in
 * tree order, so an owner is exported before the shadowed one cuts it.
 */
function exportDeepestFirst(
  before: LoroDoc,
  was: readonly PlacedWorkspaceDocument[],
  evacuees: readonly PlacedWorkspaceDocument[],
  alive: ReadonlySet<string>,
): RemovedDocument[] {
  const depth = (path: string) => path.split('/').length
  const order = [...evacuees].sort((left, right) => depth(right.path) - depth(left.path))
  const { below, atPath } = cutsByEvacuee(was, evacuees, alive)
  // How far each path's shadowing cut has got: evacuees at one path come in
  // tree order, so each resumes where the one before it stopped.
  const cutUpTo = new Map<string, number>()
  const out: RemovedDocument[] = []
  for (const evacuee of order) {
    for (const id of below.get(evacuee.path) ?? []) deleteWorkspaceNode(before, id)
    const sharing = atPath.get(evacuee.path) ?? []
    let next = cutUpTo.get(evacuee.path) ?? 0
    for (; next < sharing.length; next++) {
      const ahead = sharing[next] as PlacedWorkspaceDocument
      if (ahead.documentId === evacuee.documentId) break
      deleteWorkspaceNode(before, ahead.id)
    }
    cutUpTo.set(evacuee.path, next)
    const bytes = exportWorkspaceNodeSubtree(before, evacuee.id)
    if (bytes !== null) out.push({ documentId: evacuee.documentId, path: evacuee.path, bytes })
  }
  return out
}

/**
 * What exporting each evacuee path has to cut first, indexed in one pass:
 * every survivor below it, filed under the DEEPEST evacuee path above it —
 * the first export to reach it, since deeper ones run first — and every
 * document at the path, in tree order, for the shadowing cut.
 */
function cutsByEvacuee(
  was: readonly PlacedWorkspaceDocument[],
  evacuees: readonly PlacedWorkspaceDocument[],
  alive: ReadonlySet<string>,
) {
  const evacueePaths = new Set(evacuees.map((each) => each.path))
  const evacueeIndex = pathIndex(evacuees)
  const below = new Map<string, TreeID[]>()
  const atPath = new Map<string, PlacedWorkspaceDocument[]>()
  const fileUnder = <T>(index: Map<string, T[]>, key: string, value: T) => {
    const list = index.get(key)
    if (list === undefined) index.set(key, [value])
    else list.push(value)
  }
  for (const each of was) {
    if (evacueePaths.has(each.path)) fileUnder(atPath, each.path, each)
    if (!alive.has(each.documentId)) continue
    const deepest = nearestAncestorDocuments(evacueeIndex, each.path)[0]
    if (deepest !== undefined) fileUnder(below, deepest.path, each.id)
  }
  return { below, atPath }
}
