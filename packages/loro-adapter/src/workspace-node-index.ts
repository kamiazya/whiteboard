import type { LoroDoc, TreeID } from 'loro-crdt'
import {
  entryOfDocumentNode,
  WORKSPACE_TREE_KEY,
  type WorkspaceDocumentEntry,
  walk,
} from './workspace-tree.js'

/**
 * Which tree node holds each document id, for a record that is held and read
 * many times between edits. Finding a document by walking the tree costs the
 * record, so a listing that asks once per document costs the record squared.
 *
 * The ids are kept for the state they were read in, named by the frontiers the
 * state is at: any change to what the record holds, an edit, an import, an
 * undo, or a view moved to other versions, moves them, and a record at the same
 * frontiers holds the same nodes. Only a record whose edits are all committed
 * answers true to that, which is every record an engine holds.
 */
const kept = new WeakMap<LoroDoc, { readonly at: string; readonly nodes: Map<string, TreeID> }>()

function stateOf(doc: LoroDoc): string {
  return doc
    .frontiers()
    .map(({ peer, counter }) => `${counter}@${peer}`)
    .join(',')
}

function nodesOf(doc: LoroDoc): Map<string, TreeID> {
  const at = stateOf(doc)
  const held = kept.get(doc)
  if (held?.at === at) return held.nodes
  const nodes = new Map<string, TreeID>()
  // Tree order, first one wins: the document a lookup by walking would find.
  for (const { node, read } of walk(doc)) {
    if (read.type === 'document' && !nodes.has(read.meta.documentId)) {
      nodes.set(read.meta.documentId, node.id)
    }
  }
  kept.set(doc, { at, nodes })
  return nodes
}

/** `resolveWorkspaceDocumentById`, answering from the ids kept for the record's state. */
export function resolveIndexedWorkspaceDocument(
  doc: LoroDoc,
  documentId: string,
): WorkspaceDocumentEntry | null {
  const id = nodesOf(doc).get(documentId)
  const node = id === undefined ? undefined : doc.getTree(WORKSPACE_TREE_KEY).getNodeByID(id)
  return node === undefined ? null : entryOfDocumentNode(node)
}
