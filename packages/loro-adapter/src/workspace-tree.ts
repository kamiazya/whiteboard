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
import type { LoroTreeNode, TreeID } from 'loro-crdt'
import { LoroDoc, LoroMap, LoroText } from 'loro-crdt'
import { z } from 'zod'
import { CONTENT_CONTAINER_KEYS, type DocumentContainers } from './loro-bridge.js'

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

/**
 * A node that holds a path component but is not itself a document.
 *
 * The tree needs these and a row-backed index does not, which is the one
 * place the two models genuinely differ. `a/b` with nothing at `a` is just a
 * string in a row; in a tree, `b` has to hang off SOMETHING. So `a` becomes a
 * folder — a real node with a segment and no document.
 *
 * The alternative was to require an ancestor before a descendant, which
 * changes what a user can do (no creating a deep path in one step). Modelling
 * the folder keeps the port's behaviour and gives later folder operations —
 * move, rename, collapse — something to act on.
 */
export const workspaceFolderMetaSchema = z.object({ segment: z.string().min(1) }).strict()

/** A node of the tree: a document, or a folder standing in for a path part. */
export type WorkspaceNode =
  | { readonly type: 'document'; readonly meta: WorkspaceNodeMeta; readonly path: string }
  | { readonly type: 'folder'; readonly segment: string; readonly path: string }

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

/**
 * Pre-attaches every content container the bridge knows on a DOCUMENT node.
 *
 * On a tree node, attaching a container is an op (a doc's roots are
 * implicit). Left lazy, the first read of a missing container would attach
 * it — and a read that mutates clears the UndoManager's redo stack, which is
 * how "create → undo → read → redo" lost the redone edit. Attaching at
 * creation makes every later `getOrCreateContainer` a pure lookup.
 *
 * Document nodes only: a folder's meta is `.strict()`, so an extra key would
 * make the folder unreadable.
 */
function attachContentContainers(node: LoroTreeNode): void {
  for (const { key, kind } of CONTENT_CONTAINER_KEYS) {
    if (kind === 'map') node.data.getOrCreateContainer(key, new LoroMap())
    else node.data.getOrCreateContainer(key, new LoroText())
  }
}

type Read =
  | { readonly type: 'document'; readonly meta: WorkspaceNodeMeta }
  | { readonly type: 'folder'; readonly segment: string }

function readMeta(node: LoroTreeNode): Read | null {
  const raw = node.data.toJSON()
  const asDocument = workspaceNodeMetaSchema.safeParse(raw)
  if (asDocument.success) return { type: 'document', meta: asDocument.data }
  const asFolder = workspaceFolderMetaSchema.safeParse(raw)
  if (asFolder.success) return { type: 'folder', segment: asFolder.data.segment }
  return null
}

/**
 * Every live node, in tree order, with its derived path.
 *
 * Tree order first and path order second, because the tie-break between two
 * documents that share a path has to be the one every peer already agrees on.
 */
interface Walked {
  readonly node: LoroTreeNode
  readonly read: Read
  readonly path: string
}

function walk(doc: LoroDoc): Walked[] {
  const out: Walked[] = []
  const visit = (node: LoroTreeNode, prefix: string): void => {
    const read = readMeta(node)
    // A node whose meta this build cannot read is skipped rather than thrown
    // on: it is one node of a workspace, and refusing the whole listing over
    // it would take every other document down with it. Its CHILDREN are
    // skipped with it — their paths are undefined without their ancestor's
    // segment, and inventing one would place them somewhere nobody chose.
    if (read === null) return
    const segment = read.type === 'document' ? read.meta.segment : read.segment
    const path = prefix === '' ? segment : `${prefix}/${segment}`
    out.push({ node, read, path })
    for (const child of node.children() ?? []) visit(child, path)
  }
  for (const root of tree(doc).roots()) visit(root, '')
  return out
}

function nodeById(doc: LoroDoc, documentId: string): LoroTreeNode | null {
  for (const entry of walk(doc)) {
    if (entry.read.type === 'document' && entry.read.meta.documentId === documentId) {
      return entry.node
    }
  }
  return null
}

/** Every node, folders included, in tree order with its derived path. */
export function readWorkspaceNodes(doc: LoroDoc): WorkspaceNode[] {
  return walk(doc).map(({ read, path }) =>
    read.type === 'document'
      ? ({ type: 'document', meta: read.meta, path } as const)
      : ({ type: 'folder', segment: read.segment, path } as const),
  )
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
  const out: WorkspaceDocumentEntry[] = []
  for (const { read, path } of walk(doc)) {
    // Folders are not documents. They hold a path component so a descendant
    // has somewhere to hang, and a listing that showed them would invent
    // documents the caller never created.
    if (read.type !== 'document') continue
    const shadowed = seen.has(path)
    seen.add(path)
    out.push({ ...read.meta, path, ...(shadowed ? { shadowed: true as const } : {}) })
  }
  return out
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
    if (entry.path === path && entry.read.type === 'document') {
      return { ...entry.read.meta, path: entry.path }
    }
  }
  return null
}

export function resolveWorkspaceDocumentById(
  doc: LoroDoc,
  documentId: string,
): WorkspaceDocumentEntry | null {
  for (const entry of walk(doc)) {
    if (entry.read.type === 'document' && entry.read.meta.documentId === documentId) {
      return { ...entry.read.meta, path: entry.path }
    }
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
  attachContentContainers(node)
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
 * The node at `path`, folder or document, or `null`.
 *
 * First in tree order when more than one node carries the path — the same
 * rule `resolveWorkspaceDocument` follows, so a caller cannot end up with the
 * shadowed one from one lookup and the owner from another.
 */
function nodeAtPath(doc: LoroDoc, path: string): Walked | null {
  for (const entry of walk(doc)) {
    if (entry.path === path) return entry
  }
  return null
}

/**
 * Materialises every folder `segments` needs and answers the deepest one's id.
 *
 * `undefined` means the workspace root. Existing nodes are reused whatever
 * they are: a DOCUMENT can hold children too, so `a/b` under a document `a`
 * hangs off `a` rather than making a second `a`.
 */
export function ensureFolderPath(doc: LoroDoc, segments: readonly string[]): TreeID | undefined {
  let parent: TreeID | undefined
  let prefix = ''
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`
    const existing = nodeAtPath(doc, prefix)
    if (existing !== null) {
      parent = existing.node.id
      continue
    }
    const node = parent === undefined ? tree(doc).createNode() : tree(doc).createNode(parent)
    node.data.set('segment', segment)
    parent = node.id
  }
  doc.commit()
  return parent
}

/**
 * Creates a document AT a path, making folders above it as needed.
 *
 * A folder already standing at `path` is PROMOTED rather than given a
 * document sibling: the folder exists only because a descendant needed a
 * parent, and turning it into the document the caller asked for keeps one
 * node per path. Two nodes there would be the same collision a concurrent
 * create produces, arrived at locally where it is avoidable.
 *
 * Answers `null` when a DOCUMENT already owns the path — the caller decides
 * what that means, since the error belongs to the port and not here.
 */
export function createWorkspaceDocumentAtPath(
  doc: LoroDoc,
  input: { path: string; documentId: string; kind: DocumentKind; name?: string },
): WorkspaceDocumentEntry | null {
  const segments = input.path.split('/')
  const own = segments[segments.length - 1] as string
  const existing = nodeAtPath(doc, input.path)
  if (existing !== null && existing.read.type === 'document') return null

  const node =
    existing !== null
      ? existing.node
      : (() => {
          const parent = ensureFolderPath(doc, segments.slice(0, -1))
          return parent === undefined ? tree(doc).createNode() : tree(doc).createNode(parent)
        })()
  const meta = workspaceNodeMetaSchema.parse({
    documentId: input.documentId,
    segment: own,
    kind: input.kind,
    ...(input.name === undefined ? {} : { name: input.name }),
  })
  node.data.set('documentId', meta.documentId)
  node.data.set('segment', meta.segment)
  node.data.set('kind', meta.kind)
  if (meta.name !== undefined) node.data.set('name', meta.name)
  attachContentContainers(node)
  doc.commit()
  return { ...meta, path: input.path }
}

/**
 * Re-parents the node at `from` to sit at `to`, renaming its own segment.
 *
 * The tree carries descendants for free, which is the whole reason a move is
 * one operation here and a rewrite of every descendant row elsewhere. The
 * caller checks for collisions first; this does the move.
 */
export function moveWorkspaceNodeToPath(doc: LoroDoc, from: string, to: string): boolean {
  const source = nodeAtPath(doc, from)
  if (source === null) return false
  const segments = to.split('/')
  const own = segments[segments.length - 1] as string
  const parent = ensureFolderPath(doc, segments.slice(0, -1))
  // Re-read: `ensureFolderPath` may have created nodes, and a captured
  // LoroTreeNode is a view.
  const live = tree(doc).getNodeByID(source.node.id)
  if (live === undefined) return false
  if (parent === undefined) tree(doc).move(live.id)
  else tree(doc).move(live.id, parent)
  live.data.set('segment', own)
  doc.commit()
  return true
}

/**
 * Folds a STANDALONE document into the workspace tree as a node at `path`.
 *
 * The migration step: every pre-workspace document is its own LoroDoc with
 * root containers (`nodes`, `body`, ...), and a workspace-tree document holds
 * the same containers on a node's meta. This copies the one into the other,
 * keeping the `documentId` the caller supplies — which is the id the old
 * world already published, so nothing that names the document notices the
 * move.
 *
 * A VALUE copy, deliberately. The source's edit history stays in the old
 * store until it is retired; carrying it into the workspace document would
 * multiply the workspace's oplog by every document's past for no reader that
 * exists.
 *
 * Answers null without writing when the id is already in the tree, which is
 * what makes a crashed fold safe to run again: the work list is derived from
 * "index rows not yet in the tree", so a document folded before the crash is
 * simply not work anymore.
 */
export function adoptWorkspaceDocument(
  doc: LoroDoc,
  input: { path: string; documentId: string; kind: DocumentKind; name?: string },
  source: LoroDoc,
): WorkspaceDocumentEntry | null {
  if (resolveWorkspaceDocumentById(doc, input.documentId) !== null) return null
  const created = createWorkspaceDocumentAtPath(doc, input)
  if (created === null) return null
  if (!writeWorkspaceDocumentContent(doc, input.documentId, source)) return null
  return resolveWorkspaceDocumentById(doc, input.documentId)
}

/**
 * Replaces an EXISTING tree document's content with a standalone document's —
 * the write half of `adoptWorkspaceDocument`, exposed for callers whose node
 * already exists (seeding a freshly created document, a duplicate's copy).
 *
 * Root containers are enumerated from the JSON projection: a string is a
 * Text container and an object is a Map, which is the whole vocabulary the
 * bridge writes (container VALUES are plain objects by convention — see
 * package-loro-adapter.md). Meta keys the node carries (segment, kind, ...)
 * are scalars and never in the source, so no collision. `setContainer`
 * REPLACES what is at each key, which here is the point.
 */
export function writeWorkspaceDocumentContent(
  doc: LoroDoc,
  documentId: string,
  source: LoroDoc,
): boolean {
  const node = nodeById(doc, documentId)
  if (node === null) return false
  const projected = source.toJSON() as Record<string, unknown>
  for (const [key, value] of Object.entries(projected)) {
    if (typeof value === 'string') {
      node.data.setContainer(key, new LoroText()).insert(0, value)
    } else if (typeof value === 'object' && value !== null) {
      const map = node.data.setContainer(key, new LoroMap())
      for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
        map.set(entryKey, entryValue)
      }
    }
  }
  doc.commit()
  return true
}

/** Where a deleted document's evacuated bytes are recorded. */
export const WORKSPACE_TRASH_KEY = 'trash'

/**
 * Copies one node's meta into another, containers included.
 *
 * Generic over what the meta HOLDS rather than a list of known container
 * names: `kind()` tells a container from a scalar, so a key added to a
 * document later travels without this function being told about it. A
 * hardcoded list is the version that silently drops the newest field.
 */
function copyNodeData(source: LoroTreeNode, target: LoroTreeNode): void {
  for (const key of source.data.keys()) {
    const value = source.data.get(key) as unknown
    const kind =
      typeof value === 'object' && value !== null && 'kind' in value
        ? (value as { kind: () => string }).kind()
        : null
    if (kind === 'Map') {
      const map = target.data.setContainer(key, new LoroMap())
      for (const [entryKey, entryValue] of Object.entries(
        (value as LoroMap).toJSON() as Record<string, unknown>,
      )) {
        map.set(entryKey, entryValue)
      }
    } else if (kind === 'Text') {
      target.data.setContainer(key, new LoroText()).insert(0, (value as LoroText).toString())
    } else if (kind === null) {
      target.data.set(key, value)
    }
    // Any other container kind is dropped rather than half-copied. Nothing
    // writes one today; when something does, this is where it has to be
    // taught, and a wrong copy would be worse than a visible gap.
  }
  // A restored document must satisfy the same pre-attached-containers
  // invariant a created one does (see attachContentContainers) — a source
  // written before the invariant existed may lack some keys.
  if (source.data.get('documentId') !== undefined) attachContentContainers(target)
}

/**
 * The subtree at `path` as a standalone Loro document.
 *
 * A VALUE copy, not a history one — the evacuated bytes exist so a deleted
 * document can be brought back, and a trash does not need the edit history
 * that produced it. Measured at 2.3 KB for a document with 50 nodes and a
 * body.
 *
 * This is what makes delete recoverable at all: a deleted tree node cannot be
 * moved back, and a shallow snapshot drops its content, so nothing in the
 * live document can serve as the copy.
 */
export function exportWorkspaceSubtree(doc: LoroDoc, path: string): Uint8Array | null {
  const source = nodeAtPath(doc, path)
  if (source === null) return null
  const out = new LoroDoc()
  const outTree = out.getTree(WORKSPACE_TREE_KEY)
  const copy = (from: LoroTreeNode, parent: TreeID | undefined): void => {
    const node = parent === undefined ? outTree.createNode() : outTree.createNode(parent)
    copyNodeData(from, node)
    for (const child of from.children() ?? []) copy(child, node.id)
  }
  copy(source.node, undefined)
  out.commit()
  return out.export({ mode: 'snapshot' })
}

/**
 * Puts an exported subtree back, under `parentPath` (root when absent).
 *
 * The restored document keeps the `documentId` it was exported with, so a
 * share link that named it still resolves. Its `TreeID` is new — Loro will
 * not revive a deleted one — which is why the two identities are separate.
 */
export function importWorkspaceSubtree(
  doc: LoroDoc,
  bytes: Uint8Array,
  parentPath?: string,
): WorkspaceDocumentEntry | null {
  const source = LoroDoc.fromSnapshot(bytes)
  const roots = source.getTree(WORKSPACE_TREE_KEY).roots()
  const first = roots[0]
  if (first === undefined) return null
  const parent = parentPath === undefined ? undefined : ensureFolderPath(doc, parentPath.split('/'))
  const copy = (from: LoroTreeNode, into: TreeID | undefined): LoroTreeNode => {
    const node = into === undefined ? tree(doc).createNode() : tree(doc).createNode(into)
    copyNodeData(from, node)
    for (const child of from.children() ?? []) copy(child, node.id)
    return node
  }
  const restored = copy(first, parent)
  doc.commit()
  const meta = readMeta(restored)
  if (meta === null || meta.type !== 'document') return null
  return resolveWorkspaceDocumentById(doc, meta.meta.documentId)
}

/** What the trash records about a document that was deleted. */
export const trashEntrySchema = z
  .object({
    documentId: documentIdSchema,
    /** Where it was, for a listing a human can read. */
    path: z.string().min(1),
    deletedAt: z.number().int().nonnegative(),
    blob: z.object({
      algorithm: z.literal('sha-256'),
      digestHex: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  })
  .strict()
export type TrashEntry = z.infer<typeof trashEntrySchema>

/**
 * Records an evacuation in the workspace document itself.
 *
 * The METADATA syncs and the BYTES do not: a blob ref travels in the tree
 * like any other value, while the bytes sit in content-addressed storage that
 * every keeper already has. Deleting on one device therefore leaves the other
 * able to see what went and ask for it.
 */
export function recordTrashEntry(doc: LoroDoc, entry: TrashEntry): void {
  doc.getMap(WORKSPACE_TRASH_KEY).set(entry.documentId, trashEntrySchema.parse(entry))
  doc.commit()
}

export function readTrashEntries(doc: LoroDoc): TrashEntry[] {
  const raw = doc.getMap(WORKSPACE_TRASH_KEY).toJSON() as Record<string, unknown>
  const out: TrashEntry[] = []
  for (const value of Object.values(raw)) {
    const parsed = trashEntrySchema.safeParse(value)
    // A damaged entry is skipped rather than thrown on: it is one row of a
    // trash listing, and refusing the whole listing would hide every other
    // recoverable document behind it.
    if (parsed.success) out.push(parsed.data)
  }
  return out.sort((left, right) => right.deletedAt - left.deletedAt)
}

export function forgetTrashEntry(doc: LoroDoc, documentId: string): void {
  doc.getMap(WORKSPACE_TRASH_KEY).delete(documentId)
  doc.commit()
}

/**
 * Removes folders that hold nothing.
 *
 * A folder exists only so a descendant has somewhere to hang; one with no
 * descendants left is scaffolding for a building that is gone. Without this,
 * moving `a/b` up to `a` leaves the folder `a` behind as a second node at that
 * path — a collision the row-backed model cannot produce, because there was
 * never a row at `a` to begin with.
 *
 * Repeated to a fixpoint: emptying a folder can empty its parent.
 */
export function pruneEmptyFolders(doc: LoroDoc): void {
  let removed = true
  while (removed) {
    removed = false
    for (const entry of walk(doc)) {
      if (entry.read.type !== 'folder') continue
      if ((entry.node.children() ?? []).length > 0) continue
      tree(doc).delete(entry.node.id)
      removed = true
      break
    }
  }
  doc.commit()
}

/** Removes the node at `path`, whatever it is. */
export function deleteWorkspaceNodeAtPath(doc: LoroDoc, path: string): boolean {
  const found = nodeAtPath(doc, path)
  if (found === null) return false
  tree(doc).delete(found.node.id)
  doc.commit()
  return true
}

/**
 * A document's containers, addressed by id, for the content bridge.
 *
 * `getOrCreateContainer` and not `setContainer`: the latter REPLACES what is
 * at the key, so a second write of the same document would silently wipe
 * everything the first one put there. Measured — `setContainer` on an
 * occupied key leaves `{}`.
 */
/**
 * The inverse of `adoptWorkspaceDocument`: one document's containers, copied
 * out of its tree node into a standalone Loro document with root containers —
 * the shape every pre-workspace consumer (the daemon import, a duplicate
 * seed) still speaks.
 *
 * A VALUE copy with a fresh oplog, like the adopt direction: the caller gets
 * the current state, never the workspace document's history. Scalar meta keys
 * (segment, kind, name, documentId) are tree bookkeeping and stay behind —
 * only containers are content.
 */
export function projectWorkspaceDocument(doc: LoroDoc, documentId: string): LoroDoc | null {
  const node = nodeById(doc, documentId)
  if (node === null) return null
  const out = new LoroDoc()
  for (const key of node.data.keys()) {
    const value = node.data.get(key) as unknown
    const kind =
      typeof value === 'object' && value !== null && 'kind' in value
        ? (value as { kind: () => string }).kind()
        : null
    if (kind === 'Map') {
      const map = out.getMap(key)
      for (const [entryKey, entryValue] of Object.entries(
        (value as LoroMap).toJSON() as Record<string, unknown>,
      )) {
        map.set(entryKey, entryValue)
      }
    } else if (kind === 'Text') {
      out.getText(key).insert(0, (value as LoroText).toString())
    }
    // Scalars are node meta, not content — see the doc comment.
  }
  out.commit()
  return out
}

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
