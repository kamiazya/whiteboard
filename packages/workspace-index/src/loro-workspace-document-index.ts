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
  type LegacyRecord,
  namedFoldersAbove,
  type TrashEntry,
  type WorkspaceDocumentEntry,
  type WorkspaceNode,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  deriveCopyName,
  deriveCopyPath,
  generateDocumentId,
  isSelfOrDescendant,
  shownName,
  siblingDisplayNameTaken,
} from '@kamiazya/whiteboard-model'
import type {
  BlobRef,
  BlobStore,
  CreateDocumentInput,
  CreateWorkspaceInput,
  DeleteDocumentInput,
  DocumentDuplicates,
  DocumentEntry,
  DocumentFolders,
  DocumentIndex,
  DocumentPins,
  DocumentTrash,
  DuplicateDocumentInput,
  FolderNameEntry,
  ListDocumentsInput,
  MoveDocumentInput,
  RenameWorkspaceInput,
  ResolveDocumentByIdInput,
  ResolveDocumentInput,
  SetDocumentNameInput,
  SetDocumentPinnedInput,
  SetFolderNameInput,
  TrashEntryInput,
  WorkspaceEntry,
  WorkspaceLookup,
} from '@kamiazya/whiteboard-ports'
import {
  compareDocumentPaths,
  createDocumentInputSchema,
  createWorkspaceInputSchema,
  DisplayNameTakenError,
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathContestedError,
  DocumentPathTakenError,
  duplicateDocumentInputSchema,
  foldersIn,
  foldersMissingFor,
  KeyedSerializer,
  moveDocumentInputSchema,
  NoRoomForCopyError,
  refuseNewDocuments,
  refuseNewFolders,
  refuseNewFoldersAt,
  renameWorkspaceInputSchema,
  resolveWorkspaceHandleBy,
  setDocumentNameInputSchema,
  setFolderNameInputSchema,
  storedWorkspaceEntrySchema,
  WorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
import { type IndexRecordKind, loroIndexKind } from './index-record-kind.js'
import {
  distinctUnnamedPath,
  entryOf,
  isNamedByAnotherRow,
  refuseMovedName,
  refuseSiblingDocumentName,
  sameDisplayName,
} from './index-rules.js'
import { moveCollision } from './move-collision.js'
import { restorableTrashDocuments } from './restore-judgement.js'
import type { WorkspaceDocs } from './workspace-docs.js'

/**
 * Who keeps workspaces — the composition root's registry of them. Split from
 * `WorkspaceDocs` because a record store opens by id and cannot enumerate.
 */
export interface WorkspaceRegistry {
  listWorkspaces(): Promise<WorkspaceEntry[]>
  /**
   * The one row `lookup` names, or null. A point lookup rather than a filter
   * over `listWorkspaces`, because resolving an address runs on every
   * request: a keeper with many people answers it from an index, and a
   * listing would make each request cost every workspace the keeper holds.
   * Unvalidated, like `listWorkspaces` — the index hydrates it.
   */
  findWorkspace(lookup: WorkspaceLookup): Promise<WorkspaceEntry | null>
  /**
   * The registry's own write, for the same reason the read is here: a
   * workspace's NAME and ADDRESS are registry rows, and the tree holds
   * neither. Required rather than optional — an optional rename is one a
   * composition root can leave unwired, and the failure would not be a
   * missing feature but a rename that silently does nothing.
   */
  renameWorkspace(input: RenameWorkspaceInput): Promise<WorkspaceEntry>
}

/**
 * Whether a trash row in some workspace OTHER than `workspaceId` names `ref`.
 *
 * A trash blob is content-addressed, so the blob store holds one copy however
 * many rows name it — and a store serving several workspaces' records can be
 * named from more than one of them. Only the composition root knows which
 * workspaces share its store, so it answers; this package stays ignorant of
 * how a keeper groups them.
 */
export type TrashBlobNamedElsewhere = (input: {
  workspaceId: string
  ref: BlobRef
}) => Promise<boolean>

interface LoroWorkspaceDocumentIndexOptions<R = LegacyRecord> {
  /**
   * Absent, a blob is kept only for another row of the same workspace —
   * right for a store that serves one workspace's record, and nothing more.
   */
  readonly trashBlobNamedElsewhere?: TrashBlobNamedElsewhere
  /**
   * How a record is read and written. Absent, the record is a `LoroDoc`;
   * required for any other, which the overloads below enforce.
   */
  readonly kind?: IndexRecordKind<R>
}

export class LoroWorkspaceDocumentIndex<R = LegacyRecord>
  implements DocumentIndex, DocumentPins, DocumentFolders, DocumentTrash, DocumentDuplicates
{
  readonly #kind: IndexRecordKind<R>

  /**
   * `blobs` is required, not optional.
   *
   * An optional evacuation is one a caller can forget to wire, and the cost of
   * forgetting is not a degraded feature — it is a delete that destroys the
   * document with no way back, because a deleted tree node cannot be revived
   * and a shallow snapshot drops its content. The constructor is where that
   * is made impossible.
   */
  constructor(
    docs: WorkspaceDocs<R>,
    blobs: BlobStore,
    registry: WorkspaceRegistry,
    options: LoroWorkspaceDocumentIndexOptions<R> & { readonly kind: IndexRecordKind<R> },
  )
  constructor(
    docs: WorkspaceDocs<LegacyRecord>,
    blobs: BlobStore,
    registry: WorkspaceRegistry,
    options?: LoroWorkspaceDocumentIndexOptions<LegacyRecord>,
  )
  constructor(
    private readonly docs: WorkspaceDocs<R>,
    private readonly blobs: BlobStore,
    private readonly registry: WorkspaceRegistry,
    private readonly options: LoroWorkspaceDocumentIndexOptions<R> = {},
  ) {
    // The overloads make an absent kind mean a `LoroDoc` record, so R is
    // `LegacyRecord` whenever the default stands.
    this.#kind = options.kind ?? (loroIndexKind as unknown as IndexRecordKind<R>)
  }

  /**
   * Delegated to the composition root's registry: enumerating workspaces is
   * a property of who KEEPS them (the daemon's `workspaces` table, the
   * browser's workspaces store), and `WorkspaceDocs` deliberately opens by
   * id only. Required, not optional — an unwired registry would make every
   * workspace invisible to the one call that lists them.
   *
   * Hydrated through the port's READ schema, so a registry row stored before
   * the identity bounds lists with its refused layers absent rather than
   * failing every reader of the list.
   */
  async listWorkspaces(): Promise<WorkspaceEntry[]> {
    const rows = await this.registry.listWorkspaces()
    return rows.map((row) => storedWorkspaceEntrySchema.parse(row))
  }

  /**
   * Over the registry's point lookups, through the port's single definition
   * of the order — at most two rows read, however many workspaces it keeps. Nothing tree-shaped participates: a workspace's ADDRESS is a
   * property of who keeps it, the same reason `listWorkspaces` delegates.
   */
  async resolveWorkspace(handle: string, callerNamespace?: string): Promise<WorkspaceEntry | null> {
    return resolveWorkspaceHandleBy(
      async (lookup) => {
        const row = await this.registry.findWorkspace(lookup)
        return row === null ? null : storedWorkspaceEntrySchema.parse(row)
      },
      handle,
      callerNamespace,
    )
  }

  /**
   * Delegated for the same reason `listWorkspaces` is: identity lives in the
   * registry, and the tree document this class owns holds a workspace's
   * PLACEMENT, never its name. Nothing tree-shaped changes when a workspace
   * is renamed. Parsed here so no registry is handed a layer the model
   * refuses, whichever composition root wired it.
   */
  async renameWorkspace(input: RenameWorkspaceInput): Promise<WorkspaceEntry> {
    return this.registry.renameWorkspace(renameWorkspaceInputSchema.parse(input))
  }

  /** What this workspace could still bring back, newest first. */
  async listTrash(input: { workspaceId: string }): Promise<TrashEntry[]> {
    return this.#withRecord(input.workspaceId, (record) => this.#kind.trash(record))
  }

  /**
   * Brings a deleted document back, under the `documentId` it had.
   *
   * A COPY rather than an undelete — Loro refuses to move a deleted node back
   * — so the restored document has a new `TreeID`. Keeping the documentId is
   * what makes that invisible to anything that named the document: a share
   * link resolves to the same document it always did.
   *
   * Not part of the `DocumentIndex` port. The port is about placement, and
   * this reaches into content and blob storage; it is the `DocumentTrash`
   * capability instead.
   */
  async restoreDocument(input: {
    workspaceId: string
    documentId: string
  }): Promise<WorkspaceDocumentEntry | null> {
    return this.#mutate(input.workspaceId, async (record) => {
      const kind = this.#kind
      const entry = (await kind.trash(record)).find((row) => row.documentId === input.documentId)
      if (entry === undefined) return null
      // A second node under one id lists twice and contests its path. The row
      // stays: the trashed copy may hold what the live one lacks.
      if ((await kind.entryById(record, input.documentId)) !== null) return null
      const stored = await this.blobs.get({ ref: entry.blob })
      // The row survives a missing blob rather than being swept: it is the
      // only record that the document existed, and a listing that dropped it
      // would answer "there was never anything to restore".
      if (stored === null) return null
      // A trash row is synced data, so the blob it names is whatever the row's
      // writer chose — another row's bytes included — and its path is whatever
      // the writer wrote. Judged on scratch copies, so nothing is placed first.
      const segments = entry.path.split('/')
      const parentPath = segments.length > 1 ? segments.slice(0, -1).join('/') : undefined
      const restoring = await restorableTrashDocuments(stored.bytes, {
        documentId: input.documentId,
        parentPath,
      })
      if (restoring === null) return null
      const restored = await this.#place(record, entry, stored.bytes, parentPath, restoring)
      if (restored === null) return null
      await this.docs.save(input.workspaceId, record)
      // After the save, not before: a failure between the two would otherwise
      // leave a row naming bytes that are gone. The other order strands one
      // blob a later purge cannot reach, which costs space and not the document.
      // A restored document is a new tree node, so its next evacuation is
      // different bytes — this one is never reused.
      await this.#dropTrashBlobUnlessNamed(input.workspaceId, await kind.trash(record), entry)
      return restored
    })
  }

  /**
   * Puts the judged bytes into the record, refusing when the workspace has no
   * room for them, and takes the trash row off. `null` when the bytes hold no
   * document, with nothing written.
   */
  async #place(
    record: R,
    entry: TrashEntry,
    bytes: Uint8Array,
    parentPath: string | undefined,
    restoring: { readonly documents: number; readonly folders: number },
  ): Promise<WorkspaceDocumentEntry | null> {
    const kind = this.#kind
    // A refusal rather than null: the row is fine and restorable once the
    // workspace has room, which the caller has to be told to make.
    const nodes = await kind.nodes(record)
    refuseNewDocuments(nodes.filter((node) => node.type === 'document').length, restoring.documents)
    refuseNewFolders(foldersIn(nodes), restoring.folders + foldersMissingFor(nodes, entry.path))
    const restored = await kind.importSubtree(record, bytes, parentPath)
    if (restored === null) return null
    kind.write(record, [
      ...(entry.folderNames === undefined
        ? []
        : [
            {
              op: 'reapplyFolderNames' as const,
              args: { names: entry.folderNames.map(({ path, name }) => ({ path, name })) },
            },
          ]),
      { op: 'forgetTrashEntry', args: { documentId: entry.documentId } },
    ])
    return restored
  }

  /**
   * Destroys a trashed document for good.
   *
   * The BYTES go before the row, so a failure part-way leaves the row
   * standing: the user still sees the entry, and purging it again finishes
   * the job. The other order would leave bytes no listing points at and
   * nothing would ever reclaim.
   *
   * The bytes stay when another trash row names the same blob. Content
   * addressing makes that possible in principle (the export carries the
   * documentId, so only a replica's copy of the same document could share
   * one); a purge must not break that other row's restore. The same record
   * moved into two workspaces of one keeper names the blob from both, which
   * is why the keeper is asked as well as this workspace's own rows.
   */
  async purgeTrashEntry(input: TrashEntryInput): Promise<boolean> {
    return this.#mutate(input.workspaceId, async (record) => {
      const rows = await this.#kind.trash(record)
      const entry = rows.find((row) => row.documentId === input.documentId)
      if (entry === undefined) return false
      await this.#dropTrashBlobUnlessNamed(input.workspaceId, rows, entry)
      this.#kind.write(record, [{ op: 'forgetTrashEntry', args: { documentId: entry.documentId } }])
      await this.docs.save(input.workspaceId, record)
      return true
    })
  }

  /**
   * Serialised per workspace, which is what the port asks for in so many
   * words: "mutating operations are serialized per workspace, and each takes
   * effect as one indivisible operation or has no effect at all". A read
   * followed by a write is two steps here — the check for a taken path, then
   * the create — and without this an interleaved pair produces the duplicate
   * the check exists to prevent.
   */
  readonly #writes = new KeyedSerializer()

  #mutate<T>(workspaceId: string, body: (record: R) => Promise<T>): Promise<T> {
    return this.#writes.run(workspaceId, () => this.#withRecord(workspaceId, body))
  }

  /**
   * The record the keeper holds for the workspace, given back when `body` is
   * done with it: whoever opens a record releases it, and a `LoroDoc` has
   * nothing to give back.
   */
  async #withRecord<T>(workspaceId: string, body: (record: R) => Promise<T> | T): Promise<T> {
    const record = await this.#open(workspaceId)
    try {
      return await body(record)
    } finally {
      this.#kind.release(record)
    }
  }

  /** Stores a document's bytes and records the trash row naming them; the delete follows only once both stand. */
  async #evacuate(
    record: R,
    meta: { readonly documentId: string; readonly name?: string },
    path: string,
  ): Promise<void> {
    const bytes = this.#kind.exportSubtree(record, path)
    if (bytes === null) return
    const { ref } = await this.blobs.put({
      // Copied so the DTO's narrow buffer type is satisfied without a
      // cast: an export is `Uint8Array<ArrayBufferLike>`.
      bytes: new Uint8Array(bytes),
      contentType: 'application/octet-stream',
    })
    const named = new Map(
      (await this.#kind.folderNames(record)).map(({ path, name }) => [path, name]),
    )
    const folderNames = namedFoldersAbove(named, path)
    this.#kind.write(record, [
      {
        op: 'recordTrashEntry',
        args: {
          entry: {
            documentId: meta.documentId,
            path,
            ...(meta.name === undefined ? {} : { name: meta.name }),
            ...(folderNames.length === 0 ? {} : { folderNames }),
            deletedAt: Date.now(),
            blob: ref,
          },
        },
      },
    ])
  }

  async #dropTrashBlobUnlessNamed(
    workspaceId: string,
    rows: readonly TrashEntry[],
    entry: TrashEntry,
  ): Promise<void> {
    if (isNamedByAnotherRow(rows, entry)) return
    const elsewhere = this.options.trashBlobNamedElsewhere
    if (elsewhere !== undefined && (await elsewhere({ workspaceId, ref: entry.blob }))) return
    await this.blobs.delete({ ref: entry.blob })
  }

  async #open(workspaceId: string): Promise<R> {
    const record = await this.docs.open(workspaceId)
    // Workspaces never materialise implicitly: a typo'd id is otherwise
    // indistinguishable from a new one, and the caller gets a workspace
    // nobody asked for with their data quietly inside.
    if (record === null) throw new WorkspaceNotFoundError(workspaceId)
    return record
  }

  /**
   * Parsed although the tree keeps neither identity layer: the port says a
   * keeper may ignore them, not that it may accept what the model refuses,
   * and both keepers composing this class must refuse the same input.
   */
  async createWorkspace(raw: CreateWorkspaceInput): Promise<void> {
    const input = createWorkspaceInputSchema.parse(raw)
    return this.#writes.run(input.workspaceId, async () => {
      const record = await this.docs.create(input.workspaceId)
      try {
        await this.docs.save(input.workspaceId, record)
      } finally {
        this.#kind.release(record)
      }
    })
  }

  /**
   * The path grammar is checked HERE, the one placement write both keepers
   * share, not only at the daemon's request edges: a listing hydrates every
   * entry through `documentEntrySchema`, so one off-grammar path stored by
   * any writer made the whole workspace's list and search unreadable.
   */
  async createDocument(raw: CreateDocumentInput): Promise<DocumentEntry> {
    const input = createDocumentInputSchema.parse(raw)
    return this.#mutate(input.workspaceId, async (record) => {
      // Before the tree is touched: the record `#open` answers may be the
      // live one, so a refused create must leave nothing in it.
      const nodes = await this.#kind.nodes(record)
      refuseNewDocuments(nodes.filter((node) => node.type === 'document').length)
      refuseNewFoldersAt(nodes, input.path)
      if (input.name !== undefined) refuseSiblingDocumentName(nodes, input.path, input.name)
      const path =
        input.name === undefined &&
        !nodes.some((node) => node.type === 'document' && node.path === input.path)
          ? distinctUnnamedPath(nodes, input.path)
          : input.path
      const documentId = generateDocumentId()
      this.#kind.write(record, [
        {
          op: 'createWorkspaceDocumentAtPath',
          args: {
            path,
            documentId,
            kind: input.kind,
            ...(input.name === undefined ? {} : { name: input.name }),
          },
        },
      ])
      // Absent means a DOCUMENT already owns the path, and nothing was
      // written. A folder standing there is promoted instead, which is why
      // this is not simply "is the path occupied" — a folder occupies a path
      // without being a document.
      //
      // This check is LOCAL, and after the workspace tree it can be nothing
      // else: another replica may be creating the same path right now and
      // both will survive the merge. It stops the ordinary case — one user,
      // one device — without claiming to be a global invariant.
      const created = await this.#kind.entryById(record, documentId)
      if (created === null) throw new DocumentPathTakenError(input.workspaceId, path)
      await this.docs.save(input.workspaceId, record)
      // Through entryOf, so a create answers the same shape a resolve does —
      // updatedAt included; the conformance suite compares them directly.
      return entryOf(created)
    })
  }

  /**
   * The copy's path and name are derived HERE, inside the serialised write
   * that creates it, from what the record holds at that moment — so two
   * duplicates of one source cannot both take `-copy`, which a caller
   * deriving from a listing it read earlier could not promise. Folders count
   * as taken: a copy promoted into a folder would arrive holding documents
   * that were never its own.
   */
  async duplicateDocument(raw: DuplicateDocumentInput): Promise<DocumentEntry> {
    const input = duplicateDocumentInputSchema.parse(raw)
    return this.#mutate(input.workspaceId, async (record) => {
      const documents = await this.#kind.documents(record)
      const atPath = documents.filter((entry) => entry.path === input.path)
      if (atPath.length > 1) throw new DocumentPathContestedError(input.workspaceId, input.path)
      const source = atPath[0]
      if (source === undefined) throw new DocumentNotFoundError(input.workspaceId, input.path)
      refuseNewDocuments(documents.length)
      const path = deriveCopyPath(
        source.path,
        (await this.#kind.nodes(record)).map((node) => node.path),
      )
      if (path === null) throw new NoRoomForCopyError(source.path)
      const documentId = generateDocumentId()
      this.#kind.write(record, [
        {
          op: 'duplicateWorkspaceDocument',
          args: {
            sourceDocumentId: source.documentId,
            documentId,
            path,
            // What a person reads for each document, so the copy's name is
            // derived from — and kept apart from — what they see there.
            name: deriveCopyName(
              shownName('document', source),
              documents.map((entry) => shownName('document', entry)),
            ),
            withoutAnnotations: input.withoutAnnotations === true,
          },
        },
      ])
      const copy = await this.#kind.entryById(record, documentId)
      // Unreachable while the path above was derived free of every node.
      if (copy === null) throw new DocumentPathTakenError(input.workspaceId, path)
      await this.docs.save(input.workspaceId, record)
      return entryOf(copy)
    })
  }

  async resolveDocument(input: ResolveDocumentInput): Promise<DocumentEntry | null> {
    return this.#withRecord(input.workspaceId, async (record) => {
      // A contested path is refused, never silently resolved to whichever
      // sibling tree order favors: the caller names the winner by id, or
      // renames one. The listing (with its `shadowed` marks) is how a caller
      // sees the contest at all.
      const atPath = (await this.#kind.documents(record)).filter(
        (entry) => entry.path === input.path,
      )
      if (atPath.length > 1) throw new DocumentPathContestedError(input.workspaceId, input.path)
      const found = atPath[0]
      return found === undefined ? null : entryOf(found)
    })
  }

  async resolveDocumentById(input: ResolveDocumentByIdInput): Promise<DocumentEntry | null> {
    return this.#withRecord(input.workspaceId, async (record) => {
      const found = await this.#kind.entryById(record, input.documentId)
      return found === null ? null : entryOf(found)
    })
  }

  async listDocuments(input: ListDocumentsInput): Promise<DocumentEntry[]> {
    // The tree answers in TREE order; the port promises PATH order. Sorting
    // here rather than there is what keeps `compareDocumentPaths` — the
    // port's own comparator — the single definition of it.
    return this.#withRecord(input.workspaceId, async (record) =>
      (await this.#kind.documents(record))
        .map(entryOf)
        .sort((left, right) => compareDocumentPaths(left.path, right.path)),
    )
  }

  /** The destination is held to the path grammar, for the reason `createDocument` gives. */
  async moveDocument(raw: MoveDocumentInput): Promise<void> {
    const input = moveDocumentInputSchema.parse(raw)
    return this.#mutate(input.workspaceId, async (record) => {
      const nodes = await this.#kind.nodes(record)
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
      const taken = moveCollision(nodes, moving, input.from, input.to)
      if (taken !== undefined) throw new DocumentPathTakenError(input.workspaceId, taken)
      refuseNewFoldersAt(nodes, input.to)
      refuseMovedName(nodes, moving, input.from, input.to)
      // ONE tree move. The descendants come with it because their paths are
      // their ancestors' — there is no per-row rewrite to order, so the
      // depth-ordering a row-backed store needs does not arise. The folders
      // the move emptied go with it — see `pruneEmptyFolders`.
      this.#kind.write(record, [
        { op: 'moveWorkspaceNodeToPath', args: { from: input.from, to: input.to } },
        { op: 'pruneEmptyFolders', args: {} },
      ])
      await this.docs.save(input.workspaceId, record)
    })
  }

  async setDocumentName(raw: SetDocumentNameInput): Promise<void> {
    const input = setDocumentNameInputSchema.parse(raw)
    return this.#mutate(input.workspaceId, async (record) => {
      const nodes = await this.#kind.nodes(record)
      const self = nodes.find(
        (node): node is Extract<WorkspaceNode, { type: 'document' }> =>
          node.type === 'document' && node.meta.documentId === input.documentId,
      )
      if (self === undefined) throw new DocumentNotFoundError(input.workspaceId, input.documentId)
      if (input.name?.trim() && !sameDisplayName(self.meta.name, input.name)) {
        refuseSiblingDocumentName(nodes, self.path, input.name, input.documentId)
      }
      this.#kind.write(record, [
        {
          op: 'setWorkspaceDocumentName',
          args: {
            documentId: input.documentId,
            ...(input.name === undefined ? {} : { name: input.name }),
          },
        },
      ])
      await this.docs.save(input.workspaceId, record)
    })
  }

  /**
   * Filtered to documents the tree still holds: the pinned list is a
   * container of ids beside the tree, and a delete removes the node without
   * touching it.
   */
  async listPinnedDocuments(input: ListDocumentsInput): Promise<string[]> {
    return this.#withRecord(input.workspaceId, async (record) => {
      const live = new Set((await this.#kind.documents(record)).map((entry) => entry.documentId))
      return (await this.#kind.pinned(record)).filter((id) => live.has(id))
    })
  }

  async setDocumentPinned(input: SetDocumentPinnedInput): Promise<void> {
    return this.#mutate(input.workspaceId, async (record) => {
      if ((await this.#kind.entryById(record, input.documentId)) === null) {
        throw new DocumentNotFoundError(input.workspaceId, input.documentId)
      }
      this.#kind.write(record, [
        {
          op: 'setWorkspacePinned',
          args: { documentId: input.documentId, pinned: input.pinned },
        },
      ])
      await this.docs.save(input.workspaceId, record)
    })
  }

  /**
   * One walk of the tree's meta, and no content digest: a listing that asks
   * for folder names beside its documents pays for reading where nodes sit,
   * never for what any document says.
   */
  async listFolderNames(input: ListDocumentsInput): Promise<FolderNameEntry[]> {
    return this.#withRecord(input.workspaceId, async (record) =>
      (await this.#kind.folderNames(record))
        .map(({ path, name }) => ({ path, name }))
        .sort((left, right) => compareDocumentPaths(left.path, right.path)),
    )
  }

  /**
   * The duplicate refused here is the one this keeper can see: siblings
   * merged in from a replica that named them alike offline are kept as they
   * arrived, and only a further write naming one of them is compared.
   */
  async setFolderName(raw: SetFolderNameInput): Promise<void> {
    const input = setFolderNameInputSchema.parse(raw)
    return this.#mutate(input.workspaceId, async (record) => {
      const nodes = await this.#kind.nodes(record)
      const atPath = nodes.filter((node) => node.type === 'folder' && node.path === input.path)
      if (atPath.length === 0) throw new DocumentNotFoundError(input.workspaceId, input.path)
      const current = atPath.find((node) => node.type === 'folder' && node.name !== undefined)
      const currentName = current?.type === 'folder' ? current.name : undefined
      if (input.name !== undefined && !sameDisplayName(currentName, input.name)) {
        const others = nodes.filter((node) => node.type === 'folder' && node.path !== input.path)
        const shown = siblingDisplayNameTaken('folder', others, {
          path: input.path,
          name: input.name,
        })
        if (shown !== undefined) throw new DisplayNameTakenError('folder', input.path, shown)
      }
      this.#kind.write(record, [
        {
          op: 'setWorkspaceFolderName',
          args: {
            path: input.path,
            ...(input.name === undefined ? {} : { name: input.name }),
          },
        },
      ])
      await this.docs.save(input.workspaceId, record)
    })
  }

  async deleteDocument(input: DeleteDocumentInput): Promise<void> {
    return this.#mutate(input.workspaceId, async (record) => {
      const nodes = await this.#kind.nodes(record)
      const target = nodes.find((node) => node.path === input.path)
      // The caller wants it gone and it is.
      if (target === undefined) return
      // Every document here can hold children, so a cascade is reachable from
      // one call naming one path, and only the NAMED path is evacuated below —
      // a cascade would destroy the descendants with no trash row to bring
      // them back. Refusing makes the caller name what it is destroying.
      const descendants = nodes.filter(
        (node) => node.path !== input.path && isSelfOrDescendant(node.path, input.path),
      )
      if (descendants.length > 0) {
        // NAME a descendant, matching the other index implementations: a
        // count tells the caller to go looking, a path tells them what they
        // would be destroying.
        throw new DocumentHasDescendantsError(
          input.path,
          `Delete "${descendants[0]?.path}" and any others below it first.`,
        )
      }
      // EVACUATE FIRST. The order is the whole guarantee: if the export or the
      // blob write fails, the document is still there and the caller can try
      // again. The other order leaves nothing to try again with — a deleted
      // node cannot be moved back, and the next compaction drops its content.
      //
      // Only a DOCUMENT is evacuated. A folder holds no content of its own,
      // so there is nothing to bring back and a trash row for one would offer
      // a restore that restores nothing.
      if (target.type === 'document') await this.#evacuate(record, target.meta, input.path)
      this.#kind.write(record, [
        { op: 'deleteWorkspaceNodeAtPath', args: { path: input.path } },
        { op: 'pruneEmptyFolders', args: {} },
      ])
      await this.docs.save(input.workspaceId, record)
    })
  }
}
