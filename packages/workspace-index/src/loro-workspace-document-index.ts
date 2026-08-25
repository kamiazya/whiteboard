/**
 * The `DocumentIndex` port, over a workspace's Loro tree.
 *
 * One implementation rather than one per composition root, because a
 * tree-backed index differs between them in NOTHING — the daemon and the
 * browser read the same tree through the same functions, and only where the
 * bytes live differs. That part is `WorkspaceDocs`.
 *
 * What this file adds on top of `loro-adapter`'s tree is the port: the
 * ordering promise, the error taxonomy, and the collision rules a CRDT does
 * not enforce on its own.
 */
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  moveWorkspaceNodeToPath,
  pruneEmptyFolders,
  readWorkspaceDocuments,
  readWorkspaceNodes,
  resolveWorkspaceDocument,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import type {
  CreateDocumentInput,
  CreateWorkspaceInput,
  DeleteDocumentInput,
  DocumentEntry,
  DocumentIndex,
  ListDocumentsInput,
  MoveDocumentInput,
  ResolveDocumentByIdInput,
  ResolveDocumentInput,
  SetDocumentNameInput,
} from '@kamiazya/whiteboard-ports'
import {
  compareDocumentPaths,
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathTakenError,
  isSelfOrDescendant,
  WorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
import type { LoroDoc } from 'loro-crdt'
import type { WorkspaceDocs } from './workspace-docs.js'

/** `a/b/c` -> `a/b/x` when the subtree at `a/b` moves to `a/b/x`. */
function rewritten(path: string, from: string, to: string): string {
  return path === from ? to : `${to}${path.slice(from.length)}`
}

export class LoroWorkspaceDocumentIndex implements DocumentIndex {
  constructor(private readonly docs: WorkspaceDocs) {}

  /**
   * Serialised per workspace, which is what the port asks for in so many
   * words: "mutating operations are serialized per workspace, and each takes
   * effect as one indivisible operation or has no effect at all". A read
   * followed by a write is two steps here — the check for a taken path, then
   * the create — and without this an interleaved pair produces the duplicate
   * the check exists to prevent.
   */
  readonly #writes = new Map<string, Promise<unknown>>()

  #serialise<T>(workspaceId: string, body: () => Promise<T>): Promise<T> {
    const previous = this.#writes.get(workspaceId) ?? Promise.resolve()
    // `.then(body, body)` so a failed operation does not poison the queue.
    const next = previous.then(body, body)
    this.#writes.set(
      workspaceId,
      next.catch(() => {}),
    )
    return next
  }

  async #open(workspaceId: string): Promise<LoroDoc> {
    const doc = await this.docs.open(workspaceId)
    // Workspaces never materialise implicitly: a typo'd id is otherwise
    // indistinguishable from a new one, and the caller gets a workspace
    // nobody asked for with their data quietly inside.
    if (doc === null) throw new WorkspaceNotFoundError(workspaceId)
    return doc
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<void> {
    return this.#serialise(input.workspaceId, async () => {
      const doc = await this.docs.create(input.workspaceId)
      await this.docs.save(input.workspaceId, doc)
    })
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentEntry> {
    return this.#serialise(input.workspaceId, async () => {
      const doc = await this.#open(input.workspaceId)
      const created = createWorkspaceDocumentAtPath(doc, {
        path: input.path,
        documentId: generateDocumentId(),
        kind: input.kind,
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      // Null means a DOCUMENT already owns the path. A folder standing there
      // is promoted instead, which is why this is not simply "is the path
      // occupied" — a folder occupies a path without being a document.
      //
      // This check is LOCAL, and after the workspace tree it can be nothing
      // else: another replica may be creating the same path right now and
      // both will survive the merge. It stops the ordinary case — one user,
      // one device — without claiming to be a global invariant.
      if (created === null) throw new DocumentPathTakenError(input.workspaceId, input.path)
      await this.docs.save(input.workspaceId, doc)
      return {
        documentId: created.documentId,
        path: created.path,
        kind: created.kind,
        ...(created.name === undefined ? {} : { name: created.name }),
      }
    })
  }

  async resolveDocument(input: ResolveDocumentInput): Promise<DocumentEntry | null> {
    const doc = await this.#open(input.workspaceId)
    const found = resolveWorkspaceDocument(doc, input.path)
    return found === null ? null : entryOf(found)
  }

  async resolveDocumentById(input: ResolveDocumentByIdInput): Promise<DocumentEntry | null> {
    const doc = await this.#open(input.workspaceId)
    const found = resolveWorkspaceDocumentById(doc, input.documentId)
    return found === null ? null : entryOf(found)
  }

  async listDocuments(input: ListDocumentsInput): Promise<DocumentEntry[]> {
    const doc = await this.#open(input.workspaceId)
    // The tree answers in TREE order; the port promises PATH order. Sorting
    // here rather than there is what keeps `compareDocumentPaths` — the
    // port's own comparator — the single definition of it.
    return readWorkspaceDocuments(doc)
      .map(entryOf)
      .sort((left, right) => compareDocumentPaths(left.path, right.path))
  }

  async moveDocument(input: MoveDocumentInput): Promise<void> {
    return this.#serialise(input.workspaceId, async () => {
      const doc = await this.#open(input.workspaceId)
      const nodes = readWorkspaceNodes(doc)
      const moving = nodes.filter((node) => isSelfOrDescendant(node.path, input.from))
      // Unlike a delete, a move has a destination — doing nothing quietly
      // would be indistinguishable from having moved it.
      if (moving.length === 0) throw new DocumentNotFoundError(input.workspaceId, input.from)
      // The produced paths do not actually collide (prefix replacement keeps
      // distinct suffixes distinct), so this is a deliberate refusal rather
      // than a consequence of the collision rule below.
      if (isSelfOrDescendant(input.to, input.from)) {
        throw new DocumentMoveIntoSelfError(input.from, input.to)
      }
      const movingPaths = new Set(moving.map((node) => node.path))
      const vacated = new Set(movingPaths)
      // A FOLDER the move empties is free too, and this is the case a
      // row-backed index never meets: it has no row at `a` at all, while the
      // tree has a folder there holding the very subtree that is leaving.
      // Counting it as occupied refuses `a/b` -> `a`, which the port says
      // must succeed.
      for (const node of nodes) {
        if (node.type !== 'folder') continue
        const below = nodes.filter(
          (other) => other.path !== node.path && isSelfOrDescendant(other.path, node.path),
        )
        if (below.length > 0 && below.every((other) => movingPaths.has(other.path))) {
          vacated.add(node.path)
        }
      }
      for (const node of moving) {
        const produced = rewritten(node.path, input.from, input.to)
        // A path the move is itself emptying is free. `a/b` moving to `a`
        // produces `a/b` again from `a/b/b`, and treating that as occupied
        // would refuse a move that is perfectly well defined.
        if (vacated.has(produced)) continue
        if (nodes.some((other) => other.path === produced)) {
          throw new DocumentPathTakenError(input.workspaceId, produced)
        }
      }
      // ONE tree move. The descendants come with it because their paths are
      // their ancestors' — there is no per-row rewrite to order, so the
      // depth-ordering a row-backed store needs does not arise.
      moveWorkspaceNodeToPath(doc, input.from, input.to)
      // The folders the move emptied go with it — see `pruneEmptyFolders`.
      pruneEmptyFolders(doc)
      await this.docs.save(input.workspaceId, doc)
    })
  }

  async setDocumentName(input: SetDocumentNameInput): Promise<void> {
    return this.#serialise(input.workspaceId, async () => {
      const doc = await this.#open(input.workspaceId)
      if (resolveWorkspaceDocumentById(doc, input.documentId) === null) {
        throw new DocumentNotFoundError(input.workspaceId, input.documentId)
      }
      setWorkspaceDocumentName(doc, {
        documentId: input.documentId,
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      await this.docs.save(input.workspaceId, doc)
    })
  }

  async deleteDocument(input: DeleteDocumentInput): Promise<void> {
    return this.#serialise(input.workspaceId, async () => {
      const doc = await this.#open(input.workspaceId)
      const nodes = readWorkspaceNodes(doc)
      const target = nodes.find((node) => node.path === input.path)
      // The caller wants it gone and it is.
      if (target === undefined) return
      // Every document here can hold children, so a cascade is reachable from
      // one call naming one path — and deletion is the operation with nothing
      // to undo it. Refusing makes the caller name what it is destroying.
      const descendants = nodes.filter(
        (node) => node.path !== input.path && isSelfOrDescendant(node.path, input.path),
      )
      if (descendants.length > 0) {
        throw new DocumentHasDescendantsError(
          input.path,
          `Delete or move its ${descendants.length} descendant(s) first.`,
        )
      }
      deleteWorkspaceNodeAtPath(doc, input.path)
      pruneEmptyFolders(doc)
      await this.docs.save(input.workspaceId, doc)
    })
  }
}

function entryOf(found: {
  documentId: string
  path: string
  kind: DocumentEntry['kind']
  name?: string
}): DocumentEntry {
  return {
    documentId: found.documentId,
    path: found.path,
    ...(found.kind === undefined ? {} : { kind: found.kind }),
    ...(found.name === undefined ? {} : { name: found.name }),
  }
}
