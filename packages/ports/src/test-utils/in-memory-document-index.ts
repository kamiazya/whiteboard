import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { findDescendantPath, isSelfOrDescendant, planSubtreeMove } from '../document-path-tree.js'
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
  WorkspaceEntry,
} from '../index.js'
import {
  compareDocumentPaths,
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathTakenError,
  WorkspaceNotFoundError,
} from '../index.js'

/**
 * `DocumentIndex` with no persistence, for the DI module the tests compose
 * against. It passes the same conformance suite as the sqlite implementation,
 * which is the point: a double that satisfies the interface but not the
 * guarantees would let a tool pass here and fail against the real store.
 *
 * Serialization comes free rather than from a lock — every operation below
 * completes without awaiting, so no other caller can observe a half-applied
 * one. That is an accident of the runtime, not a design to copy: a store that
 * awaits mid-operation has to arrange it deliberately.
 */
export class InMemoryDocumentIndex implements DocumentIndex {
  readonly #workspaces = new Set<string>()
  /** Keyed by workspace, then by path — so a workspace's set is one lookup. */
  readonly #documents = new Map<string, Map<string, DocumentEntry>>()

  #inWorkspace(workspaceId: string): Map<string, DocumentEntry> {
    let documents = this.#documents.get(workspaceId)
    if (!documents) {
      documents = new Map()
      this.#documents.set(workspaceId, documents)
    }
    return documents
  }

  /**
   * Place a document at a path with an id the CALLER chose. Deliberately not
   * on `DocumentIndex`: assigning the id is the index's job, and an
   * operation that lets a caller pick one would undo that for every store.
   * A test that already holds an id — because it seeds a document store with
   * the same one — needs the two to agree, and this is how a double lets it
   * without the contract growing a hole.
   */
  seed(entry: DocumentEntry & { workspaceId: string }): void {
    const { workspaceId, ...rest } = entry
    this.#workspaces.add(workspaceId)
    this.#inWorkspace(workspaceId).set(rest.path, rest)
  }

  async createWorkspace({ workspaceId }: CreateWorkspaceInput): Promise<void> {
    this.#workspaces.add(workspaceId)
  }

  async listWorkspaces(): Promise<WorkspaceEntry[]> {
    return [...this.#workspaces].map((workspaceId) => ({ workspaceId }))
  }

  async createDocument({
    workspaceId,
    path,
    kind,
    name,
  }: CreateDocumentInput): Promise<DocumentEntry> {
    if (!this.#workspaces.has(workspaceId)) {
      throw new WorkspaceNotFoundError(workspaceId)
    }
    const documents = this.#inWorkspace(workspaceId)
    if (documents.has(path)) {
      throw new DocumentPathTakenError(workspaceId, path)
    }
    const entry: DocumentEntry = {
      documentId: generateDocumentId(),
      path,
      kind,
      ...(name === undefined ? {} : { name }),
    }
    documents.set(path, entry)
    return entry
  }

  async resolveDocument({
    workspaceId,
    path,
  }: ResolveDocumentInput): Promise<DocumentEntry | null> {
    return this.#inWorkspace(workspaceId).get(path) ?? null
  }

  async resolveDocumentById({
    workspaceId,
    documentId,
  }: ResolveDocumentByIdInput): Promise<DocumentEntry | null> {
    for (const entry of this.#inWorkspace(workspaceId).values()) {
      if (entry.documentId === documentId) return entry
    }
    return null
  }

  async setDocumentName({ workspaceId, documentId, name }: SetDocumentNameInput): Promise<void> {
    const documents = this.#inWorkspace(workspaceId)
    for (const [path, entry] of documents) {
      if (entry.documentId !== documentId) continue
      const { name: _dropped, ...rest } = entry
      documents.set(path, { ...rest, ...(name === undefined ? {} : { name }) })
      return
    }
    throw new DocumentNotFoundError(workspaceId, documentId)
  }

  async listDocuments({ workspaceId }: ListDocumentsInput): Promise<DocumentEntry[]> {
    if (!this.#workspaces.has(workspaceId)) {
      throw new WorkspaceNotFoundError(workspaceId)
    }
    return [...this.#inWorkspace(workspaceId).values()].sort((left, right) =>
      compareDocumentPaths(left.path, right.path),
    )
  }

  async moveDocument({ workspaceId, from, to }: MoveDocumentInput): Promise<void> {
    if (isSelfOrDescendant(to, from)) {
      throw new DocumentMoveIntoSelfError(from, to)
    }
    const documents = this.#inWorkspace(workspaceId)
    const rows = [...documents.values()].map((entry) => ({ id: entry.path, path: entry.path }))
    const plan = planSubtreeMove(rows, from, to)
    if (!plan.ok) {
      if (plan.reason === 'not-found') throw new DocumentNotFoundError(workspaceId, from)
      throw new DocumentPathTakenError(workspaceId, plan.path)
    }
    for (const move of plan.moves) {
      const entry = documents.get(move.from)
      if (entry === undefined) continue
      documents.delete(move.from)
      documents.set(move.path, { ...entry, path: move.path })
    }
  }

  async deleteDocument({ workspaceId, path }: DeleteDocumentInput): Promise<void> {
    const documents = this.#inWorkspace(workspaceId)
    const descendant = findDescendantPath(
      [...documents.keys()].map((key) => ({ id: key, path: key })),
      path,
    )
    if (descendant !== undefined) {
      throw new DocumentHasDescendantsError(
        path,
        `Delete "${descendant}" and any others below it first.`,
      )
    }
    documents.delete(path)
  }
}
