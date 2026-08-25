/**
 * A workspace as ONE Loro document, with every document it holds as a node of
 * a `LoroTree`.
 *
 * The tree IS the index. Placement, naming, kind and content are one
 * convergent structure rather than an index beside a pile of documents, which
 * is what lets a move and an edit merge without a coordinator — and what makes
 * "does this document exist" a question with a single answer.
 *
 * Two consequences follow from that and are not defects to be fixed later:
 *
 * - **Sibling paths are not unique.** Two peers can create `design/notes` at
 *   the same time and both survive; every peer sees them in the same order.
 *   `resolveWorkspaceDocument` gives the path to the first, and the rest are
 *   listed as `shadowed`. A rule that renamed the loser instead would need a
 *   WRITE, which a read-only replica cannot perform — so two replicas would
 *   disagree about a name until somebody wrote.
 * - **A delete cannot be undone by moving the node back.** Loro refuses
 *   (`TreeID ... is deleted or does not exist`), and a shallow snapshot drops
 *   a deleted node's content outright. Restoring is therefore a copy under the
 *   same `documentId`, which is why that id is ours and not Loro's `TreeID`.
 */

import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { documentIdSchema, documentKindSchema } from '@kamiazya/whiteboard-model'
import type { LoroDoc, LoroTreeNode, TreeID } from 'loro-crdt'
import { LoroMap, LoroText } from 'loro-crdt'
import { z } from 'zod'
import type { DocumentContainers } from './loro-bridge.js'

/** The one root container a workspace document has. */
export const WORKSPACE_TREE_KEY = 'tree'

/**
 * What a tree node records about the document it IS.
 *
 * A persisted shape, so it is declared once and hydrated through `safeParse`
 * rather than cast. `documentId` is a ULID of our own minting, deliberately
 * separate from the node's `TreeID`: a share link names the id, and a `TreeID`
 * is `counter@peerId` — peer-dependent, unreadable, and it changes when a
 * deleted document is restored.
 */
export const workspaceNodeMetaSchema = z.object({
  documentId: documentIdSchema,
  /** This document's own path component. The full path is its ancestors'. */
  segment: z.string().min(1),
  kind: documentKindSchema,
  /**
   * What a human reads, as opposed to `segment`, which is an address. Absent
   * rather than defaulted to the segment: a listing that invented one would
   * read as though somebody typed the path in as a title.
   */
  name: z.string().min(1).optional(),
})
export type WorkspaceNodeMeta = z.infer<typeof workspaceNodeMetaSchema>

export interface WorkspaceDocumentEntry extends WorkspaceNodeMeta {
  /** Derived from ancestry on every read; never stored. */
  path: string
  /**
   * True when an earlier sibling already owns this path. Only reachable
   * through concurrent creation, and shown rather than hidden — the data has
   * converged, and a listing that dropped half of it would look like loss.
   */
  shadowed?: true
}

export interface CreateWorkspaceDocumentInput extends WorkspaceNodeMeta {
  /** Omit for a document at the workspace root. */
  parentId?: string
}

function tree(doc: LoroDoc) {
  return doc.getTree(WORKSPACE_TREE_KEY)
}

function readMeta(node: LoroTreeNode): WorkspaceNodeMeta | null {
  const parsed = workspaceNodeMetaSchema.safeParse(node.data.toJSON())
  return parsed.success ? parsed.data : null
}

/**
 * Every live node, in tree order, with its derived path.
 *
 * Tree order first and path order second, because the tie-break between two
 * documents that share a path has to be the one every peer already agrees on.
 */
function walk(doc: LoroDoc): { node: LoroTreeNode; meta: WorkspaceNodeMeta; path: string }[] {
  const out: { node: LoroTreeNode; meta: WorkspaceNodeMeta; path: string }[] = []
  const visit = (node: LoroTreeNode, prefix: string): void => {
    const meta = readMeta(node)
    // A node whose meta this build cannot read is skipped rather than thrown
    // on: it is one node of a workspace, and refusing the whole listing over
    // it would take every other document down with it.
    if (meta === null) return
    const path = prefix === '' ? meta.segment : `${prefix}/${meta.segment}`
    out.push({ node, meta, path })
    for (const child of node.children() ?? []) visit(child, path)
  }
  for (const root of tree(doc).roots()) visit(root, '')
  return out
}

function nodeById(doc: LoroDoc, documentId: string): LoroTreeNode | null {
  for (const entry of walk(doc)) {
    if (entry.meta.documentId === documentId) return entry.node
  }
  return null
}

/**
 * Every document this workspace holds, in TREE order, with its derived path.
 *
 * Deliberately not sorted by path. Ordering a listing is the `DocumentIndex`
 * port's contract (`compareDocumentPaths`), and importing that here would give
 * this package a dependency on `ports` for one comparator — while the
 * shadowing rule below needs tree order and nothing else, since "an earlier
 * sibling owns this path" is a statement about the order every peer already
 * agrees on. The composition root that implements the port sorts.
 */
export function readWorkspaceDocuments(doc: LoroDoc): WorkspaceDocumentEntry[] {
  const seen = new Set<string>()
  return walk(doc).map(({ meta, path }) => {
    const shadowed = seen.has(path)
    seen.add(path)
    return { ...meta, path, ...(shadowed ? { shadowed: true as const } : {}) }
  })
}

/**
 * The document that OWNS `path` — the first in tree order, when more than one
 * carries it. The others are reachable only by id.
 */
export function resolveWorkspaceDocument(
  doc: LoroDoc,
  path: string,
): WorkspaceDocumentEntry | null {
  for (const entry of walk(doc)) {
    if (entry.path === path) return { ...entry.meta, path: entry.path }
  }
  return null
}

export function resolveWorkspaceDocumentById(
  doc: LoroDoc,
  documentId: string,
): WorkspaceDocumentEntry | null {
  for (const entry of walk(doc)) {
    if (entry.meta.documentId === documentId) return { ...entry.meta, path: entry.path }
  }
  return null
}

export function createWorkspaceDocument(
  doc: LoroDoc,
  input: CreateWorkspaceDocumentInput,
): WorkspaceDocumentEntry {
  const meta = workspaceNodeMetaSchema.parse({
    documentId: input.documentId,
    segment: input.segment,
    kind: input.kind,
    ...(input.name === undefined ? {} : { name: input.name }),
  })
  const parent = input.parentId === undefined ? null : nodeById(doc, input.parentId)
  if (input.parentId !== undefined && parent === null) {
    throw new Error(`No document "${input.parentId}" to create "${input.segment}" under`)
  }
  const node = parent === null ? tree(doc).createNode() : tree(doc).createNode(parent.id)
  node.data.set('documentId', meta.documentId)
  node.data.set('segment', meta.segment)
  node.data.set('kind', meta.kind satisfies DocumentKind)
  if (meta.name !== undefined) node.data.set('name', meta.name)
  doc.commit()
  return { ...meta, path: resolveWorkspaceDocumentById(doc, meta.documentId)?.path ?? meta.segment }
}

/**
 * Re-parents a document. Descendants come with it, because a descendant's path
 * IS its ancestors' and nothing else records the relationship — the tree does
 * the subtree arithmetic that a row-backed index has to compute.
 */
export function moveWorkspaceDocument(
  doc: LoroDoc,
  input: { documentId: string; parentId?: string },
): void {
  const node = nodeById(doc, input.documentId)
  if (node === null) throw new Error(`No document "${input.documentId}" to move`)
  const parent = input.parentId === undefined ? null : nodeById(doc, input.parentId)
  if (input.parentId !== undefined && parent === null) {
    throw new Error(`No document "${input.parentId}" to move "${input.documentId}" under`)
  }
  if (parent === null) tree(doc).move(node.id)
  else tree(doc).move(node.id, parent.id)
  doc.commit()
}

/** Sets — or, with no `name`, clears — a document's display name. */
export function setWorkspaceDocumentName(
  doc: LoroDoc,
  input: { documentId: string; name?: string },
): void {
  const node = nodeById(doc, input.documentId)
  if (node === null) throw new Error(`No document "${input.documentId}" to rename`)
  if (input.name === undefined) node.data.delete('name')
  else node.data.set('name', input.name)
  doc.commit()
}

/**
 * Removes a document and its descendants from the tree.
 *
 * Final, in the sense that matters: the node cannot be moved back, and a
 * shallow snapshot drops its content. A caller that wants the content
 * recoverable has to copy it out BEFORE calling this — see the trash design.
 */
export function deleteWorkspaceDocument(doc: LoroDoc, input: { documentId: string }): void {
  const node = nodeById(doc, input.documentId)
  if (node === null) return
  tree(doc).delete(node.id)
  doc.commit()
}

/**
 * A document's containers, addressed by id, for the content bridge.
 *
 * `getOrCreateContainer` and not `setContainer`: the latter REPLACES what is
 * at the key, so a second write of the same document would silently wipe
 * everything the first one put there. Measured — `setContainer` on an
 * occupied key leaves `{}`.
 */
export function documentContainers(doc: LoroDoc, documentId: string): DocumentContainers {
  const node = nodeById(doc, documentId)
  if (node === null) throw new Error(`No document "${documentId}" in this workspace`)
  const id: TreeID = node.id
  // Resolved per call rather than captured, so a handle stays valid across a
  // move: `move` re-parents the same TreeID, but a captured LoroTreeNode is a
  // view that a concurrent import can leave behind.
  const live = (): LoroTreeNode => {
    const current = tree(doc).getNodeByID(id)
    if (current === undefined) throw new Error(`Document "${documentId}" is no longer present`)
    return current
  }
  return {
    getMap: (key) => live().data.getOrCreateContainer(key, new LoroMap()),
    getText: (key) => live().data.getOrCreateContainer(key, new LoroText()),
    commit: () => doc.commit(),
  }
}
