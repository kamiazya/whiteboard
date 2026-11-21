import type { LoroDoc, LoroTreeNode, TreeID } from 'loro-crdt'
import {
  entryOfDocumentNode,
  WORKSPACE_TREE_KEY,
  type WorkspaceDocumentEntry,
  walk,
} from './workspace-tree.js'

/**
 * Which tree node holds each document id and each path, for a record that is
 * held and read many times between edits. Finding a document by walking the
 * tree costs the record, so a listing that asks once per document costs the
 * record squared, and a read that names one document costs the record each time.
 *
 * The nodes are kept for the state they were read in, named by the frontiers
 * the state is at: any change to what the record holds, an edit, an import, an
 * undo, or a view moved to other versions, moves them, and a record at the same
 * frontiers holds the same nodes. Reading the frontiers commits what is pending
 * first, so an edit nobody committed moves them as well:
 * `readers.node-lookup.property.test.ts` makes such edits straight at the tree
 * and holds the lookups to a walk of it.
 */
interface Held {
  readonly at: string
  readonly byId: Map<string, TreeID>
  readonly byPath: Map<string, TreeID>
}

const kept = new WeakMap<LoroDoc, Held>()

function stateOf(doc: LoroDoc): string {
  return doc
    .frontiers()
    .map(({ peer, counter }) => `${counter}@${peer}`)
    .join(',')
}

function build(doc: LoroDoc, at: string): Held {
  const byId = new Map<string, TreeID>()
  const byPath = new Map<string, TreeID>()
  // Tree order, first one wins: the document a lookup by walking would find.
  for (const { node, read, path } of walk(doc)) {
    if (read.type !== 'document') continue
    if (!byId.has(read.meta.documentId)) byId.set(read.meta.documentId, node.id)
    if (!byPath.has(path)) byPath.set(path, node.id)
  }
  const held = { at, byId, byPath }
  kept.set(doc, held)
  return held
}

/** The kept lookups for the state the record is at, built by a walk when it has moved since they were. */
function heldFor(doc: LoroDoc): Held {
  const at = stateOf(doc)
  const held = kept.get(doc)
  return held?.at === at ? held : build(doc, at)
}

function nodeOf(doc: LoroDoc, id: TreeID | undefined): LoroTreeNode | null {
  return id === undefined ? null : (doc.getTree(WORKSPACE_TREE_KEY).getNodeByID(id) ?? null)
}

/** The node of the document `documentId`, as a walk of the tree would find it; `null` when the record holds none. */
export function nodeByDocumentId(doc: LoroDoc, documentId: string): LoroTreeNode | null {
  return nodeOf(doc, heldFor(doc).byId.get(documentId))
}

/** `resolveWorkspaceDocumentById`, answering from the nodes kept for the record's state. */
export function resolveIndexedWorkspaceDocument(
  doc: LoroDoc,
  documentId: string,
): WorkspaceDocumentEntry | null {
  const node = nodeByDocumentId(doc, documentId)
  return node === null ? null : entryOfDocumentNode(node)
}

/** `resolveWorkspaceDocument`, answering from the nodes kept for the record's state. */
export function resolveIndexedWorkspaceDocumentAtPath(
  doc: LoroDoc,
  path: string,
): WorkspaceDocumentEntry | null {
  const node = nodeOf(doc, heldFor(doc).byPath.get(path))
  return node === null ? null : entryOfDocumentNode(node)
}
