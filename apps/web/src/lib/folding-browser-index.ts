/**
 * The browser's production `DocumentIndex`: the workspace-tree index, behind
 * a one-time startup fold.
 *
 * The tree only knows documents that are IN it, and an existing browser's
 * documents are per-document records until something folds them. The
 * document backend folds when it opens a document, and the promote dialog
 * before it counts; but the LIST page is often the first thing a returning
 * user sees — served straight from this index — so the fold has to gate the
 * index itself or a legacy user opens an empty gallery over a database full
 * of documents.
 *
 * One shared promise, not a per-call fold. Listing and resolving documents
 * wait for every index write this tab has issued and then for that run
 * (`settledForRead`). Every other method but `renameWorkspace` waits for the
 * run alone — writes above all, since the save loop that issues them is one
 * of the writes a read waits for. A failure logs, clears the memo so a later
 * call retries, and lets the call proceed (`foldOrServeTheTree`).
 */
import { documentKindSchema } from '@kamiazya/whiteboard-model'
import {
  type CreateDocumentInput,
  type CreateWorkspaceInput,
  compareDocumentPaths,
  type DeleteDocumentInput,
  type DocumentDuplicates,
  type DocumentEntry,
  DocumentHasDescendantsError,
  type DocumentIndex,
  type DocumentPins,
  type DocumentTrash,
  type DuplicateDocumentInput,
  findDescendantPath,
  isWorkspaceNotFoundError,
  type ListDocumentsInput,
  type MoveDocumentInput,
  type RenameWorkspaceInput,
  type ResolveDocumentByIdInput,
  type ResolveDocumentInput,
  type SetDocumentNameInput,
  type SetDocumentPinnedInput,
  type WorkspaceEntry,
} from '@kamiazya/whiteboard-ports'
import { LoroWorkspaceDocumentIndex } from '@kamiazya/whiteboard-workspace-index'
import { getAppLogger } from './app-logger.js'
import {
  browserKeeperCapacity,
  type KeeperCapacity,
  WorkspaceCapacityReachedError,
} from './browser-keeper-capacity.js'
import { deleteVersionRowsOfDocument } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { foldOrServeTheTree, retireLegacyDocument } from './fold-workspace.js'
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
} from './workspace-broadcast.js'
import { documentIdsInRecord } from './workspace-record-ids.js'

const log = getAppLogger('folding-browser-index')

export class FoldingBrowserIndex
  implements DocumentIndex, DocumentPins, DocumentTrash, DocumentDuplicates
{
  private readonly inner: LoroWorkspaceDocumentIndex
  private readonly legacy: IdbDocumentIndex
  private folded: Promise<void> | null = null
  private readonly capacity: KeeperCapacity

  constructor(
    private readonly dbName?: string,
    options: { capacity?: KeeperCapacity } = {},
  ) {
    this.capacity = options.capacity ?? browserKeeperCapacity()
    this.legacy = new IdbDocumentIndex(dbName)
    this.inner = new LoroWorkspaceDocumentIndex(
      new BrowserWorkspaceDocs(dbName),
      new IdbBlobStore(dbName),
      // The browser's workspaces registry lives in the same IndexedDB store
      // the legacy index keeps it in — registration, not placement, so it is
      // not part of what the fold retires.
      {
        listWorkspaces: () => this.legacy.listWorkspaces(),
        renameWorkspace: (input) => this.legacy.renameWorkspace(input),
      },
    )
  }

  // ── fold-skipped fallback ──
  //
  // The fold leaves a record it cannot read where it is, and fold-workspace.ts
  // promises that record is "still reported by the old path as
  // damaged-but-present". This index is the old path's successor, so the
  // promise is kept HERE: a legacy row whose document never made it into the
  // tree is still listed, resolvable and deletable, and opening it reaches
  // LoroStore.load's classification (update-to-open vs corrupt) instead of a
  // silent disappearance. A pre-kind row stays invisible — that is this
  // project's own pre-release data defect, ignored by standing decision.

  /** Legacy rows serving documents the tree does not hold, valid-kind only. */
  private async foldSkippedRows(workspaceId: string): Promise<DocumentEntry[]> {
    let rows: DocumentEntry[]
    try {
      rows = await this.legacy.listDocuments({ workspaceId })
    } catch (error) {
      // No legacy workspace means nothing was ever skipped. Anything else is
      // a real storage failure and must not be silently read as "no rows".
      if (isWorkspaceNotFoundError(error)) return []
      throw error
    }
    const kinded = rows.filter((row) => documentKindSchema.safeParse(row.kind).success)
    if (kinded.length === 0) return []
    // One read of the record for every row, not one per row: a listing pays
    // for this on every call.
    const record = await new BrowserWorkspaceDocs(this.dbName).open(workspaceId)
    if (record === null) return kinded
    const held = documentIdsInRecord(record)
    return kinded.filter((row) => !held.has(row.documentId))
  }

  async listWorkspaces(): Promise<WorkspaceEntry[]> {
    await this.ensureFolded()
    return this.inner.listWorkspaces()
  }

  async resolveWorkspace(handle: string): Promise<WorkspaceEntry | null> {
    await this.ensureFolded()
    return this.inner.resolveWorkspace(handle)
  }

  /**
   * No fold first: a rename writes a registry row, and the fold is about
   * DOCUMENTS. Waiting on it would make renaming a workspace pay for
   * migrating another one's contents.
   */
  async renameWorkspace(input: RenameWorkspaceInput): Promise<WorkspaceEntry> {
    return this.inner.renameWorkspace(input)
  }

  /**
   * What a document read waits for: the fold, and every index write this tab
   * has issued or queued (`pending-index-writes.ts`). Without the second, the
   * listing taken as a page closes answers from before its last rename. Reads
   * only: the save loop registered there calls `setDocumentName`, and a write
   * that waited here would wait on itself.
   */
  private async settledForRead(): Promise<void> {
    await indexWritesSettled()
    await this.ensureFolded()
  }

  private ensureFolded(): Promise<void> {
    this.folded ??= foldOrServeTheTree(log, this.dbName).then((report) => {
      if (report === null) {
        // Cleared so the NEXT call retries — a transient failure must not
        // pin this session to an unfolded view forever.
        this.folded = null
        return
      }
      // A skipped document is one the fold left OUT of the tree, served only
      // by the fold-skipped fallback below, so the count must reach a log
      // even though the fold itself succeeded.
      if (report.skipped > 0) {
        log.warn('startup fold left documents behind', {
          folded: report.folded,
          skipped: report.skipped,
        })
      }
    })
    return this.folded
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
    await this.ensureFolded()
    await this.legacy.createWorkspace(input)
    return this.inner.createWorkspace(input)
  }

  /**
   * Every way a browser-kept workspace gains a document ends here, so this is
   * where its capacity is held (ADR-0044 decision 2). Only GROWTH is refused:
   * the cost follows the document count, so editing what is already there
   * stays open, and nothing already kept becomes unreadable.
   */
  async createDocument(input: CreateDocumentInput): Promise<DocumentEntry> {
    await this.ensureFolded()
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
    await this.ensureFolded()
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
    const held = await this.listDocuments({ workspaceId })
    if (held.length >= this.capacity.limit) {
      throw new WorkspaceCapacityReachedError(this.capacity.limit)
    }
  }

  async resolveDocument(input: ResolveDocumentInput): Promise<DocumentEntry | null> {
    await this.settledForRead()
    const fromTree = await this.inner.resolveDocument(input)
    if (fromTree !== null) return fromTree
    const skipped = await this.foldSkippedRows(input.workspaceId)
    return skipped.find((row) => row.path === input.path) ?? null
  }

  async resolveDocumentById(input: ResolveDocumentByIdInput): Promise<DocumentEntry | null> {
    await this.settledForRead()
    const fromTree = await this.inner.resolveDocumentById(input)
    if (fromTree !== null) return fromTree
    const skipped = await this.foldSkippedRows(input.workspaceId)
    return skipped.find((row) => row.documentId === input.documentId) ?? null
  }

  async listDocuments(input: ListDocumentsInput): Promise<DocumentEntry[]> {
    await this.settledForRead()
    const fromTree = await this.inner.listDocuments(input)
    const skipped = await this.foldSkippedRows(input.workspaceId)
    if (skipped.length === 0) return fromTree
    return [...fromTree, ...skipped].sort((a, b) => compareDocumentPaths(a.path, b.path))
  }

  async moveDocument(input: MoveDocumentInput): Promise<void> {
    await this.ensureFolded()
    await this.inner.moveDocument(input)
    announceDocumentMoved(input.workspaceId, input.from, input.to)
  }

  async setDocumentName(input: SetDocumentNameInput): Promise<void> {
    await this.ensureFolded()
    await this.inner.setDocumentName(input)
    announceDocumentRenamed(input.workspaceId, input.documentId)
  }

  async listPinnedDocuments(input: ListDocumentsInput): Promise<string[]> {
    await this.ensureFolded()
    return this.inner.listPinnedDocuments(input)
  }

  async setDocumentPinned(input: SetDocumentPinnedInput): Promise<void> {
    await this.ensureFolded()
    await this.inner.setDocumentPinned(input)
    announceDocumentPinned(input.workspaceId, input.documentId)
  }

  /** What deletes evacuated; not on the port — callers hold this class. */
  async listTrash(input: {
    workspaceId: string
  }): ReturnType<LoroWorkspaceDocumentIndex['listTrash']> {
    await this.ensureFolded()
    return this.inner.listTrash(input)
  }

  /** Bring one evacuated document back under the SAME documentId. */
  async restoreDocument(
    input: Parameters<LoroWorkspaceDocumentIndex['restoreDocument']>[0],
  ): ReturnType<LoroWorkspaceDocumentIndex['restoreDocument']> {
    await this.ensureFolded()
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
    await this.ensureFolded()
    const purged = await this.inner.purgeTrashEntry(input)
    if (purged) {
      await deleteVersionRowsOfDocument(input.workspaceId, input.documentId, this.dbName)
      await forgetContentTimestamp(input.documentId, this.dbName)
    }
    return purged
  }

  async deleteDocument(input: DeleteDocumentInput): Promise<void> {
    await this.ensureFolded()
    if ((await this.inner.resolveDocument(input)) !== null) {
      await this.inner.deleteDocument(input)
    } else {
      // A fold-skipped document lives only in the legacy row; deleting it there
      // is what lets a user clear a damaged document instead of keeping an
      // error screen forever. It has no trash to be restored from, so it is
      // retired outright — record, row and listing clock. Only a row the
      // fallback LISTS: one whose id the tree holds is the fold's to retire.
      const skipped = await this.foldSkippedRows(input.workspaceId)
      const row = skipped.find((entry) => entry.path === input.path)
      if (row !== undefined) {
        // The port's delete refuses a parent; the retirement goes by id and
        // would not, so the refusal is asked first.
        const below = findDescendantPath(
          skipped.map((entry) => ({ id: entry.documentId, path: entry.path })),
          input.path,
        )
        if (below !== undefined) {
          throw new DocumentHasDescendantsError(
            input.path,
            `Delete "${below}" and any others below it first.`,
          )
        }
        await retireLegacyDocument({
          workspaceId: input.workspaceId,
          documentId: row.documentId,
          keptByTree: false,
          ...(this.dbName === undefined ? {} : { dbName: this.dbName }),
        })
      }
    }
    announceDocumentRemoved(input.workspaceId, input.path)
  }
}

// The lazy pages share ONE instance so the startup fold runs once and every
// listing sees the same tree view. It lives here rather than in App state
// because App is the ENTRY chunk: a static App.tsx import of this module put
// loro-crdt's WASM bindings on the first-paint critical path (measured 114 →
// 158.9 KB gzip; entry-graph-loro-free.test.ts pins the boundary). Every
// consumer is a React.lazy page, so the class stays in a lazy chunk.
let shared: FoldingBrowserIndex | null = null

export function sharedFoldingBrowserIndex(): FoldingBrowserIndex {
  shared ??= new FoldingBrowserIndex()
  return shared
}
