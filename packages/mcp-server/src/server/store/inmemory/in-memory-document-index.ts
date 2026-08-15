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
} from '@kamiazya/whiteboard-canvas-ports'
import {
  compareDocumentPaths,
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathTakenError,
  WorkspaceNotFoundError,
} from '@kamiazya/whiteboard-canvas-ports'
import { generateCanvasId } from '@kamiazya/whiteboard-server-core'

/** Whether `path` is `ancestor` itself or sits below it. */
function isSelfOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

/** How many segments a path has. */
function depth(path: string): number {
  return path.split('/').length
}

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

  async createWorkspace({ workspaceId }: CreateWorkspaceInput): Promise<void> {
    this.#workspaces.add(workspaceId)
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
      canvasId: generateCanvasId(),
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
    canvasId,
  }: ResolveDocumentByIdInput): Promise<DocumentEntry | null> {
    for (const entry of this.#inWorkspace(workspaceId).values()) {
      if (entry.canvasId === canvasId) return entry
    }
    return null
  }

  async listDocuments({ workspaceId }: ListDocumentsInput): Promise<DocumentEntry[]> {
    return [...this.#inWorkspace(workspaceId).values()].sort((left, right) =>
      compareDocumentPaths(left.path, right.path),
    )
  }

  async moveDocument({ workspaceId, from, to }: MoveDocumentInput): Promise<void> {
    if (isSelfOrDescendant(to, from)) {
      throw new DocumentMoveIntoSelfError(from, to)
    }
    const documents = this.#inWorkspace(workspaceId)
    const moving = [...documents.values()].filter((entry) => isSelfOrDescendant(entry.path, from))
    if (moving.length === 0) {
      throw new DocumentNotFoundError(workspaceId, from)
    }
    const vacating = new Set(moving.map((entry) => entry.path))
    const rewritten = moving.map((entry) => ({
      entry,
      path: `${to}${entry.path.slice(from.length)}`,
    }))
    for (const { path } of rewritten) {
      if (documents.has(path) && !vacating.has(path)) {
        throw new DocumentPathTakenError(workspaceId, path)
      }
    }
    // Shallowest source first, for the same reason the sqlite store sorts:
    // moving up into one's own ancestor namespace sends a deeper row onto a
    // path a shallower one is still vacating.
    rewritten.sort((left, right) => depth(left.entry.path) - depth(right.entry.path))
    for (const { entry, path } of rewritten) {
      documents.delete(entry.path)
      documents.set(path, { ...entry, path })
    }
  }

  async deleteDocument({ workspaceId, path }: DeleteDocumentInput): Promise<void> {
    const documents = this.#inWorkspace(workspaceId)
    const descendant = [...documents.keys()].find((candidate) => candidate.startsWith(`${path}/`))
    if (descendant !== undefined) {
      throw new DocumentHasDescendantsError(
        path,
        `Delete "${descendant}" and any others below it first.`,
      )
    }
    documents.delete(path)
  }
}
