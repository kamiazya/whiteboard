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
import { LoroWorkspaceDocumentIndex } from '@kamiazya/whiteboard-workspace-index'
import { getAppLogger } from './app-logger.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { foldWorkspaceDocuments } from './fold-workspace.js'
import { IdbBlobStore } from './idb-blob-store.js'

const log = getAppLogger('folding-browser-index')

export class FoldingBrowserIndex implements DocumentIndex {
  private readonly inner: LoroWorkspaceDocumentIndex
  private folded: Promise<void> | null = null

  constructor(private readonly dbName?: string) {
    this.inner = new LoroWorkspaceDocumentIndex(
      new BrowserWorkspaceDocs(dbName),
      new IdbBlobStore(dbName),
    )
  }

  private ensureFolded(): Promise<void> {
    this.folded ??= foldWorkspaceDocuments(this.dbName)
      .then(() => undefined)
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
    return this.inner.resolveDocument(input)
  }

  async resolveDocumentById(input: ResolveDocumentByIdInput): Promise<DocumentEntry | null> {
    await this.ensureFolded()
    return this.inner.resolveDocumentById(input)
  }

  async listDocuments(input: ListDocumentsInput): Promise<DocumentEntry[]> {
    await this.ensureFolded()
    return this.inner.listDocuments(input)
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
    return this.inner.deleteDocument(input)
  }
}
