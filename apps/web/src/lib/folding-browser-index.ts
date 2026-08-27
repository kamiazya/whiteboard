/**
 * The browser's production `DocumentIndex`: the workspace-tree index, behind
 * a one-time startup fold.
 *
 * The tree only knows documents that are IN it, and an existing browser's
 * documents are per-document records until something folds them. The
 * document page's backend and the markdown hook each fold on their own load,
 * but the LIST page is often the first thing a returning user sees — served
 * straight from this index — so the fold has to gate the index itself or a
 * legacy user opens an empty gallery over a database full of documents.
 *
 * One shared promise, not a per-call fold: every method awaits the same
 * first run. A failure logs, clears the memo so a later call retries, and
 * lets the call proceed — the fold is migration, and refusing to list what
 * IS in the tree over a fold hiccup would be worse than a briefly
 * incomplete list.
 */
import { documentKindSchema } from '@kamiazya/whiteboard-model'
import {
  type CreateDocumentInput,
  type CreateWorkspaceInput,
  compareDocumentPaths,
  type DeleteDocumentInput,
  type DocumentEntry,
  type DocumentIndex,
  isWorkspaceNotFoundError,
  type ListDocumentsInput,
  type MoveDocumentInput,
  type ResolveDocumentByIdInput,
  type ResolveDocumentInput,
  type SetDocumentNameInput,
} from '@kamiazya/whiteboard-ports'
import { LoroWorkspaceDocumentIndex } from '@kamiazya/whiteboard-workspace-index'
import { getAppLogger } from './app-logger.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { foldWorkspaceDocuments } from './fold-workspace.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { IdbDocumentIndex } from './idb-document-index.js'

const log = getAppLogger('folding-browser-index')

export class FoldingBrowserIndex implements DocumentIndex {
  private readonly inner: LoroWorkspaceDocumentIndex
  private readonly legacy: IdbDocumentIndex
  private folded: Promise<void> | null = null

  constructor(private readonly dbName?: string) {
    this.legacy = new IdbDocumentIndex(dbName)
    this.inner = new LoroWorkspaceDocumentIndex(
      new BrowserWorkspaceDocs(dbName),
      new IdbBlobStore(dbName),
      // The browser's workspaces registry lives in the same IndexedDB store
      // the legacy index keeps it in — registration, not placement, so it is
      // not part of what the fold retires.
      { listWorkspaces: () => this.legacy.listWorkspaces() },
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
    const skipped: DocumentEntry[] = []
    for (const row of rows) {
      if (!documentKindSchema.safeParse(row.kind).success) continue
      if (
        (await this.inner.resolveDocumentById({ workspaceId, documentId: row.documentId })) !== null
      )
        continue
      skipped.push(row)
    }
    return skipped
  }

  async listWorkspaces(): Promise<{ workspaceId: string }[]> {
    await this.ensureFolded()
    return this.inner.listWorkspaces()
  }

  private ensureFolded(): Promise<void> {
    this.folded ??= foldWorkspaceDocuments(this.dbName)
      .then((report) => {
        // A skipped document is one the fold left OUT of the tree — from
        // here on it is invisible to every listing, so the count must reach
        // a log even though the fold itself succeeded.
        if (report.skipped > 0) {
          log.warn('startup fold left documents behind', {
            folded: report.folded,
            skipped: report.skipped,
          })
        }
      })
      .catch((err: unknown) => {
        log.warn('startup fold failed; the index serves what the tree holds', err)
        // Cleared so the NEXT call retries — a transient failure must not
        // pin this session to an unfolded view forever.
        this.folded = null
      })
    return this.folded
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<void> {
    await this.ensureFolded()
    return this.inner.createWorkspace(input)
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentEntry> {
    await this.ensureFolded()
    return this.inner.createDocument(input)
  }

  async resolveDocument(input: ResolveDocumentInput): Promise<DocumentEntry | null> {
    await this.ensureFolded()
    const fromTree = await this.inner.resolveDocument(input)
    if (fromTree !== null) return fromTree
    const skipped = await this.foldSkippedRows(input.workspaceId)
    return skipped.find((row) => row.path === input.path) ?? null
  }

  async resolveDocumentById(input: ResolveDocumentByIdInput): Promise<DocumentEntry | null> {
    await this.ensureFolded()
    const fromTree = await this.inner.resolveDocumentById(input)
    if (fromTree !== null) return fromTree
    const skipped = await this.foldSkippedRows(input.workspaceId)
    return skipped.find((row) => row.documentId === input.documentId) ?? null
  }

  async listDocuments(input: ListDocumentsInput): Promise<DocumentEntry[]> {
    await this.ensureFolded()
    const fromTree = await this.inner.listDocuments(input)
    const skipped = await this.foldSkippedRows(input.workspaceId)
    if (skipped.length === 0) return fromTree
    return [...fromTree, ...skipped].sort((a, b) => compareDocumentPaths(a.path, b.path))
  }

  async moveDocument(input: MoveDocumentInput): Promise<void> {
    await this.ensureFolded()
    return this.inner.moveDocument(input)
  }

  async setDocumentName(input: SetDocumentNameInput): Promise<void> {
    await this.ensureFolded()
    return this.inner.setDocumentName(input)
  }

  async deleteDocument(input: DeleteDocumentInput): Promise<void> {
    await this.ensureFolded()
    if ((await this.inner.resolveDocument(input)) !== null) {
      return this.inner.deleteDocument(input)
    }
    // A fold-skipped document lives only in the legacy row; deleting it there
    // is what lets a user clear a damaged document instead of keeping an
    // error screen forever.
    return this.legacy.deleteDocument(input)
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
