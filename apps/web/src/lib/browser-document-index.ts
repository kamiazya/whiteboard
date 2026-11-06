/**
 * The browser's production `DocumentIndex`: the workspace-tree index, with
 * the keeper's own concerns around it — the workspaces registry, capacity,
 * the cross-tab announcements, and the refusal of a workspace whose
 * documents predate the tree.
 *
 * A workspace that still holds the per-document rows older builds wrote is
 * REFUSED on every document call (`BrowserStorageRefusedError`), never read:
 * the tree does not hold those documents, so answering from it would list a
 * workspace full of documents as empty. The probe runs once per workspace and
 * its answer is kept, since nothing this build does writes such a row.
 *
 * What each method waits for, which is what makes it safe to call from a
 * promise registered with the write barrier (`pending-index-writes.ts`):
 * only `listDocuments`, `resolveDocument` and `resolveDocumentById` wait for
 * every index write this tab has issued (`settledForRead`). Every other
 * method waits for the probe alone, and the probe and every registry read go
 * through `registry`, which never waits at the barrier. So any method but
 * those three may be called by a tracked writer such as the document
 * controller's save loop.
 */
import {
  type CreateDocumentInput,
  type CreateWorkspaceInput,
  type DeleteDocumentInput,
  type DocumentDuplicates,
  type DocumentEntry,
  type DocumentFolders,
  type DocumentIndex,
  type DocumentPins,
  type DocumentTrash,
  type DuplicateDocumentInput,
  type FolderNameEntry,
  type ListDocumentsInput,
  type MoveDocumentInput,
  matchesWorkspaceLookup,
  type RenameWorkspaceInput,
  type ResolveDocumentByIdInput,
  type ResolveDocumentInput,
  type SetDocumentNameInput,
  type SetDocumentPinnedInput,
  type SetFolderNameInput,
  type WorkspaceEntry,
} from '@kamiazya/whiteboard-ports'
import { LoroWorkspaceDocumentIndex } from '@kamiazya/whiteboard-workspace-index'
import {
  browserKeeperCapacity,
  type KeeperCapacity,
  WorkspaceCapacityReachedError,
} from './browser-keeper-capacity.js'
import { BrowserStorageRefusedError } from './browser-storage-refusal.js'
import { deleteVersionRowsOfDocument } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { sweepAfterPurge } from './file-sweep-schedule.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { forgetContentTimestamp, touchContentTimestamp } from './loro-store.js'
import { indexWritesSettled } from './pending-index-writes.js'
import {
  announceDocumentCreated,
  announceDocumentMoved,
  announceDocumentPinned,
  announceDocumentRemoved,
  announceDocumentRenamed,
  announceDocumentRestored,
  announceFolderRenamed,
} from './workspace-broadcast.js'

export class BrowserDocumentIndex
  implements DocumentIndex, DocumentPins, DocumentTrash, DocumentDuplicates, DocumentFolders
{
  private readonly inner: LoroWorkspaceDocumentIndex
  private readonly registry: IdbDocumentIndex
  /** One settle per workspace; see `settleWorkspace`. */
  private readonly settled = new Map<string, Promise<void>>()
  private readonly capacity: KeeperCapacity

  constructor(
    private readonly dbName?: string,
    options: { capacity?: KeeperCapacity } = {},
  ) {
    this.capacity = options.capacity ?? browserKeeperCapacity()
    // No barrier on its reads: they serve writes and workspace reads, which
    // a tracked writer may make (see the header). Sound because what the
    // barrier adds over IndexedDB's own transaction order is the writes
    // queued but not yet issued, and those are document renames, which touch
    // neither a pre-tree row nor the registry.
    this.registry = new IdbDocumentIndex(dbName, { readsAwaitIssuedWrites: false })
    this.inner = new LoroWorkspaceDocumentIndex(
      new BrowserWorkspaceDocs(dbName),
      new IdbBlobStore(dbName),
      // The browser's workspaces registry — registration, not placement, so
      // it lives beside the tree rather than in it.
      {
        listWorkspaces: () => this.registry.listWorkspaces(),
        // Over the listing: this registry is one person's, so it holds what
        // that person made, and nobody else's workspaces can make it large.
        findWorkspace: async (lookup) =>
          (await this.registry.listWorkspaces()).find((entry) =>
            matchesWorkspaceLookup(entry, lookup),
          ) ?? null,
        renameWorkspace: (input) => this.registry.renameWorkspace(input),
      },
    )
  }

  /**
   * The registry is not refused: a workspace whose documents predate the tree
   * is still a workspace the switcher lists, so the page can open it and say
   * why its documents cannot be read, and another workspace can be made.
   */
  async listWorkspaces(): Promise<WorkspaceEntry[]> {
    return this.inner.listWorkspaces()
  }

  async resolveWorkspace(handle: string): Promise<WorkspaceEntry | null> {
    return this.inner.resolveWorkspace(handle)
  }

  async renameWorkspace(input: RenameWorkspaceInput): Promise<WorkspaceEntry> {
    return this.inner.renameWorkspace(input)
  }

  /**
   * What a document read waits for: every index write this tab has issued
   * or queued (`pending-index-writes.ts`), then the refusal probe. Without the
   * first, the listing taken as a page closes answers from before its last
   * rename. The three document reads only: the save loop registered there
   * calls `setDocumentName`, and a write that waited here would wait on
   * itself.
   */
  private async settledForRead(workspaceId: string): Promise<void> {
    await indexWritesSettled()
    await this.settleWorkspace(workspaceId)
  }

  /**
   * Settles a workspace before its first document call, once per workspace:
   * rejects with `BrowserStorageRefusedError` when it still holds documents
   * older builds wrote outside the tree, and otherwise mints the record of a
   * workspace the registry holds but the tree has never written — a fresh
   * browser, or the empty workspace a demote leaves — so it lists as empty
   * rather than as missing. A refusal is kept; a probe that FAILED is not, so
   * a transient storage error is retried by the next call rather than pinned
   * for the session.
   */
  private settleWorkspace(workspaceId: string): Promise<void> {
    const known = this.settled.get(workspaceId)
    if (known !== undefined) return known
    const probe = this.settleOnce(workspaceId).catch((err: unknown) => {
      if (!(err instanceof BrowserStorageRefusedError)) this.settled.delete(workspaceId)
      throw err
    })
    this.settled.set(workspaceId, probe)
    return probe
  }

  private async settleOnce(workspaceId: string): Promise<void> {
    if (await this.registry.holdsPreTreeRecords(workspaceId)) {
      throw new BrowserStorageRefusedError('pre-tree-records', workspaceId)
    }
    const registered = (await this.registry.listWorkspaces()).some(
      (entry) => entry.workspaceId === workspaceId,
    )
    if (registered) await new BrowserWorkspaceDocs(this.dbName).create(workspaceId)
  }

  /**
   * Both halves of what a workspace IS: identity (segment, displayName) into
   * the registry, placement into the tree. The tree index alone cannot do
   * this — its `createWorkspace` deliberately never writes a registry row —
   * so delegating only there created a workspace `listWorkspaces` could not
   * report and `resolveWorkspace` could not address. The registry write is
   * create-if-absent, so re-creating an existing workspace bare never
   * clobbers identity it already carries.
   */
  async createWorkspace(input: CreateWorkspaceInput): Promise<void> {
    await this.registry.createWorkspace(input)
    return this.inner.createWorkspace(input)
  }

  /**
   * Every way a browser-kept workspace gains a document ends here, so this is
   * where its capacity is held (ADR-0044 decision 2). Only GROWTH is refused:
   * the cost follows the document count, so editing what is already there
   * stays open, and nothing already kept becomes unreadable.
   */
  async createDocument(input: CreateDocumentInput): Promise<DocumentEntry> {
    await this.settleWorkspace(input.workspaceId)
    await this.admitOneMore(input.workspaceId)
    const created = await this.inner.createDocument(input)
    announceDocumentCreated(input.workspaceId, created.path)
    return created
  }

  /**
   * The copy grows the workspace as a create does, so it is admitted the same
   * way. Its listing clock is stamped here because the write went into the
   * record directly, past the store that would otherwise stamp it.
   */
  async duplicateDocument(input: DuplicateDocumentInput): Promise<DocumentEntry> {
    await this.settleWorkspace(input.workspaceId)
    await this.admitOneMore(input.workspaceId)
    const copy = await this.inner.duplicateDocument(input)
    await touchContentTimestamp(copy.documentId, this.dbName)
    announceDocumentCreated(input.workspaceId, copy.path)
    return copy
  }

  /**
   * ponytail: check-then-write, not atomic. Creates racing in this tab or
   * others can each pass and overshoot by how many raced; the count comes
   * from each tab's own replica of the record, so even a cross-tab lock
   * would not make it exact. The limit sits well under where a tab fails,
   * so a few over is harmless. Serialise through the workspace record's
   * write queue if it ever needs to be exact.
   */
  private async admitOneMore(workspaceId: string): Promise<void> {
    // Counted past the barrier, not through `listDocuments`: a create can be
    // made by a tracked writer, and the count would then wait on that writer.
    const held = await this.inner.listDocuments({ workspaceId })
    if (held.length >= this.capacity.limit) {
      throw new WorkspaceCapacityReachedError(this.capacity.limit)
    }
  }

  async resolveDocument(input: ResolveDocumentInput): Promise<DocumentEntry | null> {
    await this.settledForRead(input.workspaceId)
    return this.inner.resolveDocument(input)
  }

  async resolveDocumentById(input: ResolveDocumentByIdInput): Promise<DocumentEntry | null> {
    await this.settledForRead(input.workspaceId)
    return this.inner.resolveDocumentById(input)
  }

  async listDocuments(input: ListDocumentsInput): Promise<DocumentEntry[]> {
    await this.settledForRead(input.workspaceId)
    return this.inner.listDocuments(input)
  }

  async moveDocument(input: MoveDocumentInput): Promise<void> {
    await this.settleWorkspace(input.workspaceId)
    await this.inner.moveDocument(input)
    announceDocumentMoved(input.workspaceId, input.from, input.to)
  }

  async setDocumentName(input: SetDocumentNameInput): Promise<void> {
    await this.settleWorkspace(input.workspaceId)
    await this.inner.setDocumentName(input)
    announceDocumentRenamed(input.workspaceId, input.documentId)
  }

  async listPinnedDocuments(input: ListDocumentsInput): Promise<string[]> {
    await this.settleWorkspace(input.workspaceId)
    return this.inner.listPinnedDocuments(input)
  }

  async setDocumentPinned(input: SetDocumentPinnedInput): Promise<void> {
    await this.settleWorkspace(input.workspaceId)
    await this.inner.setDocumentPinned(input)
    announceDocumentPinned(input.workspaceId, input.documentId)
  }

  async listFolderNames(input: ListDocumentsInput): Promise<FolderNameEntry[]> {
    await this.settleWorkspace(input.workspaceId)
    return this.inner.listFolderNames(input)
  }

  async setFolderName(input: SetFolderNameInput): Promise<void> {
    await this.settleWorkspace(input.workspaceId)
    await this.inner.setFolderName(input)
    announceFolderRenamed(input.workspaceId, input.path)
  }

  /** What deletes evacuated; not on the port — callers hold this class. */
  async listTrash(input: {
    workspaceId: string
  }): ReturnType<LoroWorkspaceDocumentIndex['listTrash']> {
    await this.settleWorkspace(input.workspaceId)
    return this.inner.listTrash(input)
  }

  /** Bring one evacuated document back under the SAME documentId. */
  async restoreDocument(
    input: Parameters<LoroWorkspaceDocumentIndex['restoreDocument']>[0],
  ): ReturnType<LoroWorkspaceDocumentIndex['restoreDocument']> {
    await this.settleWorkspace(input.workspaceId)
    // A restore adds a document back just as a create does.
    await this.admitOneMore(input.workspaceId)
    const restored = await this.inner.restoreDocument(input)
    if (restored !== null) announceDocumentRestored(input.workspaceId, restored.path)
    return restored
  }

  /**
   * Destroy one trashed document for good, saved versions included: they were
   * kept so a restore could rejoin them, and after a purge nothing can.
   */
  async purgeTrashEntry(
    input: Parameters<LoroWorkspaceDocumentIndex['purgeTrashEntry']>[0],
  ): ReturnType<LoroWorkspaceDocumentIndex['purgeTrashEntry']> {
    await this.settleWorkspace(input.workspaceId)
    const purged = await this.inner.purgeTrashEntry(input)
    if (purged) {
      await deleteVersionRowsOfDocument(input.workspaceId, input.documentId, this.dbName)
      await forgetContentTimestamp(input.documentId, this.dbName)
      sweepAfterPurge(this.dbName)
    }
    return purged
  }

  async deleteDocument(input: DeleteDocumentInput): Promise<void> {
    await this.settleWorkspace(input.workspaceId)
    await this.inner.deleteDocument(input)
    announceDocumentRemoved(input.workspaceId, input.path)
  }
}

// The lazy pages share ONE instance so the refusal probe runs once and every
// listing sees the same tree view. It lives here rather than in App state
// because App is the ENTRY chunk: a static App.tsx import of this module put
// loro-crdt's WASM bindings on the first-paint critical path (measured 114 →
// 158.9 KB gzip; entry-graph-loro-free.test.ts pins the boundary). Every
// consumer is a React.lazy page, so the class stays in a lazy chunk.
let shared: BrowserDocumentIndex | null = null

export function sharedBrowserDocumentIndex(): BrowserDocumentIndex {
  shared ??= new BrowserDocumentIndex()
  return shared
}
