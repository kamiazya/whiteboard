import {
  deriveCopyName,
  deriveCopyPath,
  generateDocumentId,
  isSelfOrDescendant,
} from '@kamiazya/whiteboard-model'
import { findDescendantPath, planSubtreeMove } from '../document-path-tree.js'
import type {
  CreateDocumentInput,
  CreateWorkspaceInput,
  DeleteDocumentInput,
  DocumentDuplicates,
  DocumentEntry,
  DocumentIndex,
  DocumentPins,
  DuplicateDocumentInput,
  ListDocumentsInput,
  MoveDocumentInput,
  RenameWorkspaceInput,
  ResolveDocumentByIdInput,
  ResolveDocumentInput,
  SetDocumentNameInput,
  SetDocumentPinnedInput,
  WorkspaceEntry,
} from '../index.js'
import {
  compareDocumentPaths,
  createDocumentInputSchema,
  createWorkspaceInputSchema,
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathTakenError,
  duplicateDocumentInputSchema,
  moveDocumentInputSchema,
  NoRoomForCopyError,
  renameWorkspaceInputSchema,
  resolveWorkspaceHandle,
  setDocumentNameInputSchema,
  storedWorkspaceEntrySchema,
  WorkspaceNotFoundError,
  WorkspaceSegmentTakenError,
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
export class InMemoryDocumentIndex implements DocumentIndex, DocumentPins {
  readonly #workspaces = new Map<string, WorkspaceEntry>()
  /** Keyed by workspace, then by path — so a workspace's set is one lookup. */
  readonly #documents = new Map<string, Map<string, DocumentEntry>>()
  /** Pinned documentIds per workspace, in pin order. */
  readonly #pinned = new Map<string, string[]>()

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
    if (!this.#workspaces.has(workspaceId)) this.#workspaces.set(workspaceId, { workspaceId })
    this.#inWorkspace(workspaceId).set(rest.path, rest)
  }

  /**
   * Puts a registry row in as given, unchecked — what a keeper holds from
   * before a bound existed, which `createWorkspace` would now refuse.
   */
  seedWorkspace(entry: WorkspaceEntry): void {
    this.#workspaces.set(entry.workspaceId, entry)
  }

  /**
   * Stores the whole entry, not just the id: `segment` is what an address
   * resolves through, so a double that dropped it would satisfy the
   * interface while making `resolveWorkspace` unable to answer — the exact
   * gap the conformance suite exists to close.
   */
  async createWorkspace(input: CreateWorkspaceInput): Promise<void> {
    const { workspaceId, segment, displayName } = createWorkspaceInputSchema.parse(input)
    // Creating one that exists leaves it ALONE — it is not an error, and it is
    // not an overwrite either. The bare `{ workspaceId }` call is what an
    // "ensure it exists" caller makes, and treating it as a full row would
    // clear the identity layers a rename put there.
    if (this.#workspaces.has(workspaceId)) return
    this.#workspaces.set(workspaceId, {
      workspaceId,
      ...(segment === undefined ? {} : { segment }),
      ...(displayName === undefined ? {} : { displayName }),
    })
  }

  async listWorkspaces(): Promise<WorkspaceEntry[]> {
    return [...this.#workspaces.values()].map((row) => storedWorkspaceEntrySchema.parse(row))
  }

  async renameWorkspace(input: RenameWorkspaceInput): Promise<WorkspaceEntry> {
    const { workspaceId, segment, displayName } = renameWorkspaceInputSchema.parse(input)
    const current = this.#workspaces.get(workspaceId)
    if (current === undefined) throw new WorkspaceNotFoundError(workspaceId)
    if (
      segment !== undefined &&
      [...this.#workspaces.values()].some(
        (entry) => entry.segment === segment && entry.workspaceId !== workspaceId,
      )
    ) {
      throw new WorkspaceSegmentTakenError(segment)
    }
    const renamed: WorkspaceEntry = {
      ...current,
      ...(segment === undefined ? {} : { segment }),
      ...(displayName === undefined ? {} : { displayName }),
    }
    this.#workspaces.set(workspaceId, renamed)
    return renamed
  }

  async resolveWorkspace(handle: string): Promise<WorkspaceEntry | null> {
    return resolveWorkspaceHandle(await this.listWorkspaces(), handle)
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentEntry> {
    const { workspaceId, path, kind, name } = createDocumentInputSchema.parse(input)
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

  async setDocumentName(input: SetDocumentNameInput): Promise<void> {
    const { workspaceId, documentId, name } = setDocumentNameInputSchema.parse(input)
    const documents = this.#inWorkspace(workspaceId)
    for (const [path, entry] of documents) {
      if (entry.documentId !== documentId) continue
      const { name: _dropped, ...rest } = entry
      documents.set(path, { ...rest, ...(name?.trim() ? { name } : {}) })
      return
    }
    throw new DocumentNotFoundError(workspaceId, documentId)
  }

  async setDocumentPinned({
    workspaceId,
    documentId,
    pinned,
  }: SetDocumentPinnedInput): Promise<void> {
    const held = [...this.#inWorkspace(workspaceId).values()].some(
      (entry) => entry.documentId === documentId,
    )
    if (!held) throw new DocumentNotFoundError(workspaceId, documentId)
    const current = this.#pinned.get(workspaceId) ?? []
    if (pinned) {
      if (!current.includes(documentId)) this.#pinned.set(workspaceId, [...current, documentId])
    } else {
      this.#pinned.set(
        workspaceId,
        current.filter((id) => id !== documentId),
      )
    }
  }

  async listPinnedDocuments({ workspaceId }: ListDocumentsInput): Promise<string[]> {
    if (!this.#workspaces.has(workspaceId)) {
      throw new WorkspaceNotFoundError(workspaceId)
    }
    const live = new Set(
      [...this.#inWorkspace(workspaceId).values()].map((entry) => entry.documentId),
    )
    return (this.#pinned.get(workspaceId) ?? []).filter((id) => live.has(id))
  }

  async listDocuments({ workspaceId }: ListDocumentsInput): Promise<DocumentEntry[]> {
    if (!this.#workspaces.has(workspaceId)) {
      throw new WorkspaceNotFoundError(workspaceId)
    }
    return [...this.#inWorkspace(workspaceId).values()].sort((left, right) =>
      compareDocumentPaths(left.path, right.path),
    )
  }

  async moveDocument(input: MoveDocumentInput): Promise<void> {
    const { workspaceId, from, to } = moveDocumentInputSchema.parse(input)
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

  /**
   * Places a copy of the document at `path` beside it, under the same
   * derivation the tree-backed index runs, and hands the two ids to
   * `copyContent` before the copy becomes visible. Synchronous, so it is
   * serialised the way every other write here is.
   *
   * Protected because this index holds no content: only a subclass that is
   * given a content record to copy may offer `DocumentDuplicates`.
   */
  protected placeCopy(
    raw: DuplicateDocumentInput,
    copyContent: (sourceDocumentId: string, copyDocumentId: string) => void,
  ): DocumentEntry {
    const { workspaceId, path } = duplicateDocumentInputSchema.parse(raw)
    if (!this.#workspaces.has(workspaceId)) throw new WorkspaceNotFoundError(workspaceId)
    const documents = this.#inWorkspace(workspaceId)
    const source = documents.get(path)
    if (source === undefined) throw new DocumentNotFoundError(workspaceId, path)
    const copyPath = deriveCopyPath(source.path, occupiedPaths(documents.keys()))
    if (copyPath === null) throw new NoRoomForCopyError(source.path)
    const copy: DocumentEntry = {
      documentId: generateDocumentId(),
      path: copyPath,
      kind: source.kind,
      name: deriveCopyName(
        source.name ?? source.path,
        [...documents.values()].map((entry) => entry.name ?? entry.path),
      ),
    }
    copyContent(source.documentId, copy.documentId)
    documents.set(copyPath, copy)
    return copy
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

/**
 * Every path a row-backed workspace occupies: each document's, and each
 * folder its path implies. A tree-backed index holds those folders as nodes,
 * and a copy must not land on one there either.
 */
function occupiedPaths(documentPaths: Iterable<string>): Set<string> {
  const occupied = new Set<string>()
  for (const path of documentPaths) {
    const segments = path.split('/')
    for (let depth = 1; depth <= segments.length; depth++) {
      occupied.add(segments.slice(0, depth).join('/'))
    }
  }
  return occupied
}

/**
 * Copies one document's content record to another id. Synchronous, so the
 * duplicate that calls it completes without awaiting; a throw leaves no copy.
 */
export interface InMemoryContentCopy {
  copy(sourceDocumentId: string, copyDocumentId: string): void
}

/**
 * `InMemoryDocumentIndex` with the `DocumentDuplicates` capability, for a
 * double that keeps document content beside the index — so a test that
 * duplicates runs the same placement the keepers do, and the copy holds
 * what its source held. Held to the same conformance suite as they are.
 */
export class DuplicatingInMemoryDocumentIndex
  extends InMemoryDocumentIndex
  implements DocumentDuplicates
{
  readonly #content: InMemoryContentCopy

  constructor(content: InMemoryContentCopy) {
    super()
    this.#content = content
  }

  async duplicateDocument(input: DuplicateDocumentInput): Promise<DocumentEntry> {
    return this.placeCopy(input, (from, to) => this.#content.copy(from, to))
  }
}
