import type {
  BinaryFileDataLike,
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  adoptWorkspaceDocument,
  createWorkspaceDocumentAtPath,
  resolveWorkspaceDocumentById,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { isStoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { Loro, type LoroDoc } from 'loro-crdt'
import { getAppLogger } from './app-logger.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { DocumentFileStore, dataUrlToBlob } from './document-file-store.js'
import { foldWorkspaceDocuments } from './fold-workspace.js'
import { LoroStore, touchContentTimestamp } from './loro-store.js'

/**
 * The document a BrowserBackend serves. `path`/`kind`/`name` are what connect
 * needs to place the document in the workspace tree when it is not there yet
 * (a fresh document, or a record the startup fold could not classify) — the
 * page already holds all three from the index row it loaded.
 */
export interface BrowserBackendTarget {
  documentId: string
  path: string
  kind: DocumentKind
  name?: string
}

/**
 * BrowserBackend: DocumentBackend implementation for fully offline, browser
 * use — backed by the WORKSPACE document.
 *
 * The bytes this backend delivers and persists are one Loro document holding
 * every document the browser keeps, each as a workspace-tree node
 * (`docRefKey({kind:'workspace-tree'})` in the same IndexedDB stores). The
 * sync session edits it through its content scope
 * (`SessionDeps.contentDocumentId`), so a local update's ops land on this
 * document's tree node. Persistence is the shared incremental shape
 * (`DocumentStoreWorkspaceDocs.save`): append a delta per push, fold when the
 * log passes the budget, never write when nothing changed.
 *
 * connect() runs the startup fold first, so per-document records written by
 * older builds (or seeded by tests through the old stores) are in the tree
 * before the snapshot is delivered. A record the fold deliberately left
 * behind is handled here, where the page's own knowledge fills the gap:
 * a pre-kind row is adopted under the kind the page opened it as, and an
 * unreadable record surfaces its load failure instead of being shadowed by
 * an empty tree node — the old record stays the damaged document's home.
 *
 * getFile/putFile: images are persisted to IndexedDB via DocumentFileStore,
 * unchanged by the workspace-document move.
 *
 * sendClientReady/sendExportResponse: no WebSocket in browser mode; no-ops.
 *
 * TOCTOU safety: all writes are serialized through a per-instance promise
 * chain (_writeQueue) so concurrent pushLocalUpdate calls import and save in
 * order.
 */
export class BrowserBackend implements DocumentBackend {
  private readonly target: BrowserBackendTarget
  private readonly docs: WorkspaceDocs
  private readonly legacy: LoroStore
  private readonly fileStore: DocumentFileStore
  private handlers: DocumentBackendHandlers | null = null
  private disconnected = false
  /** The live workspace document — set once connect() has delivered it. */
  private workspaceDoc: LoroDoc | null = null
  /** Serializes all write operations (pushLocalUpdate) to prevent TOCTOU races. */
  private _writeQueue: Promise<void> = Promise.resolve()

  constructor(
    target: BrowserBackendTarget,
    docs?: WorkspaceDocs,
    fileStore?: DocumentFileStore,
    legacy?: LoroStore,
  ) {
    this.target = target
    this.docs = docs ?? new BrowserWorkspaceDocs()
    this.legacy = legacy ?? new LoroStore()
    this.fileStore = fileStore ?? new DocumentFileStore()
  }

  connect(handlers: DocumentBackendHandlers): void {
    this.disconnected = false
    this.handlers = handlers
    this.workspaceDoc = null
    // Fire synchronously so the caller can observe onConnected immediately.
    handlers.onConnected()
    this.loadAndDeliver(handlers).catch(() => {
      if (this.isStale(handlers)) return
      handlers.onError?.('storage-failure')
    })
  }

  disconnect(): void {
    this.disconnected = true
    this.handlers = null
    this.workspaceDoc = null
  }

  /**
   * Accept a local Loro update — ops against the WORKSPACE document. Imported
   * into this backend's own instance (idempotent, so the reconnect full-state
   * re-send merges as a no-op) and persisted through the shared incremental
   * save. Writes are chained onto _writeQueue so two concurrent calls apply
   * in order with no lost update.
   */
  pushLocalUpdate(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return Promise.resolve()
    // Both the document and the WORKSPACE are captured here, at enqueue, not
    // read again when the queued write runs. What runs later runs after
    // whatever else happened in between, and two things can happen:
    //
    // - `disconnect()` nulls `workspaceDoc` synchronously, so a write still
    //   on the queue used to find nothing to land on and return — dropping
    //   the edit the person had just made. A workspace switch unmounts the
    //   session at exactly that moment.
    // - The active workspace is re-pointed by the address, so reading
    //   `getBrowserWorkspaceId()` late filed these bytes under the workspace
    //   being switched TO. Losing an edit is bad; putting it in another
    //   workspace is worse.
    const workspaceDoc = this.workspaceDoc
    const workspaceId = workspaceDoc === null ? null : getBrowserWorkspaceId()
    this._writeQueue = this._writeQueue.then(() => this._doWrite(bytes, workspaceDoc, workspaceId))
    return this._writeQueue
  }

  /**
   * Make this backend's document equal `past` — the browser's restore.
   *
   * The daemon restores by reconciling onto the LIVE doc and letting the
   * workspace record's funnel fan the resulting ops to every client. Here
   * the live doc is this backend's own workspace record, and the one client
   * is the sync session holding its twin — so the same reconcile
   * (`writeWorkspaceDocumentContent`, a diff and never a rewrite) runs on
   * the record, the ops it produced are persisted, and those ops reach the
   * session the way a peer's would: as a remote update. Nothing rewinds in
   * a CRDT; the session's own later ops stay in its history and the restore
   * is one more edit on top of them.
   *
   * Bracketed with the restore events the daemon sends, so a page that
   * renders the restore overlay for a daemon restore renders it here too.
   * Queued behind pending pushes so a keystroke in flight is reconciled
   * over, not lost under, the restore.
   */
  applyRestore(past: LoroDoc, label?: string): Promise<void> {
    const workspaceDoc = this.workspaceDoc
    const workspaceId = workspaceDoc === null ? null : getBrowserWorkspaceId()
    const handlers = this.handlers
    const run = async (): Promise<void> => {
      if (workspaceDoc === null || workspaceId === null || handlers === null) {
        throw new Error('restore before the document was delivered')
      }
      handlers.onRestoreStarted(label === undefined ? {} : { label })
      try {
        const before = workspaceDoc.version()
        writeWorkspaceDocumentContent(workspaceDoc, this.target.documentId, past)
        const update = workspaceDoc.export({ mode: 'update', from: before })
        await this.docs.save(workspaceId, workspaceDoc)
        await touchContentTimestamp(this.target.documentId)
        if (update.length > 0 && !this.isStale(handlers)) handlers.onRemoteUpdate(update)
      } finally {
        if (!this.isStale(handlers)) handlers.onRestoreComplete()
      }
    }
    const queued = this._writeQueue.then(run)
    // The queue itself must never reject, or every later push would be
    // refused by a restore that failed before it.
    this._writeQueue = queued.catch(() => {})
    return queued
  }

  private async _doWrite(
    bytes: Uint8Array,
    workspaceDoc: LoroDoc | null,
    workspaceId: string | null,
  ): Promise<void> {
    // A push before the snapshot was delivered has nothing to land on — the
    // session cannot produce one, since its doc exists only after onSnapshot.
    if (workspaceDoc === null || workspaceId === null) return
    try {
      workspaceDoc.import(bytes)
      await this.docs.save(workspaceId, workspaceDoc)
      // The listing's updatedAt: stamped per push, keyed by the document this
      // backend serves — the workspace document itself has no row to stamp.
      await touchContentTimestamp(this.target.documentId)
    } catch {
      this.handlers?.onError?.('storage-failure')
    }
  }

  /**
   * Returns the persisted Blob for fileId, or null for an unknown id and for
   * a corrupt/unknown-version record — never calls onError, since a read-path
   * miss is not a storage failure (see DocumentFileStore.get).
   */
  async getFile(fileId: string): Promise<Blob | null> {
    return this.fileStore.get(fileId)
  }

  /**
   * Persists each entry keyed by its tuple fileId (the dedupe key
   * useDocumentSync already uses — never `data.id`, which a caller's
   * BinaryFileDataLike is not guaranteed to agree with). Calls
   * onFileSuccess once per successfully stored entry. Rejects and routes
   * handlers.onError?.('storage-failure') on any store failure so a failed
   * upload is never observed as a silent success.
   */
  async putFile(
    newEntries: [string, BinaryFileDataLike][],
    onFileSuccess: (fileId: string) => void,
  ): Promise<void> {
    if (newEntries.length === 0) return

    try {
      for (const [fileId, data] of newEntries) {
        const blob = dataUrlToBlob(data.dataURL, data.mimeType)
        await this.fileStore.put(fileId, {
          mimeType: blob.type,
          blob,
          created: data.created,
        })
        onFileSuccess(fileId)
      }
    } catch (err) {
      this.handlers?.onError?.('storage-failure')
      throw err
    }
  }

  /** No WebSocket in browser mode. */
  sendClientReady(): void {
    /* no-op */
  }

  /** No WebSocket in browser mode. */
  sendExportResponse(_requestId: string, _data: string): void {
    /* no-op */
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /** True once the original connect() handlers are no longer the live ones. */
  private isStale(handlers: DocumentBackendHandlers): boolean {
    return this.disconnected || this.handlers !== handlers
  }

  private async loadAndDeliver(handlers: DocumentBackendHandlers): Promise<void> {
    // Any per-document records first fold into the tree, so a document
    // created by an older build is served from the same place as everything
    // else. Derived work list — a second connect finds nothing pending.
    // Non-fatal on failure: the fold retries at the next connect, and the
    // placeMissingDocument path below still classifies this backend's own
    // document — degrading the open over a fold hiccup would take the whole
    // editor down for a step that is only migration.
    try {
      await foldWorkspaceDocuments()
    } catch (err) {
      getAppLogger('browser-backend').warn('startup fold failed; continuing without it', err)
    }
    if (this.isStale(handlers)) return

    let workspaceDoc: LoroDoc
    try {
      workspaceDoc = await this.docs.create(getBrowserWorkspaceId())
    } catch (err) {
      // WHICH failure this was decides what the reader is told, and the two
      // sentences are about different things.
      //
      // A typed unreadable error is a claim about the RECORD: every document
      // is in the workspace document, so this is the browser twin of a
      // corrupt per-document snapshot, and `corrupt-snapshot` is what the
      // page turns into a full-page "This canvas’s data could not be read."
      //
      // Anything else is a read that never completed — a blocked open
      // (another tab holding this app at an older version, which
      // `openWhiteboardDb` rejects by name), an aborted transaction, storage
      // that went away. Nothing about the stored bytes is known, and calling
      // that damage accuses data that is sitting intact on disk — the one
      // thing `document-read-failure.ts` says these sentences must never do,
      // and worse, the page answers `corrupt-snapshot` with a Start fresh
      // button that DELETES the record. `read-unavailable` keeps the page
      // level treatment, since the content did not arrive either way and an
      // editor over an empty canvas would be its own lie, and changes what
      // is said and what is offered.
      if (!this.isStale(handlers)) {
        handlers.onError?.(
          isStoredDocumentUnreadableError(err) ? 'corrupt-snapshot' : 'read-unavailable',
        )
      }
      getAppLogger('browser-backend').warn('opening the workspace record failed', err)
      return
    }
    if (this.isStale(handlers)) return

    if (resolveWorkspaceDocumentById(workspaceDoc, this.target.documentId) === null) {
      const settled = await this.placeMissingDocument(workspaceDoc, handlers)
      if (!settled) return
    }
    if (this.isStale(handlers)) return

    this.workspaceDoc = workspaceDoc
    handlers.onSnapshot(workspaceDoc.export({ mode: 'snapshot' }))
  }

  /**
   * The document is not in the tree after the fold. Three explanations, three
   * answers:
   *
   * - its old record is UNREADABLE → surface that record's own failure and
   *   deliver nothing. Creating an empty node here would shadow a document
   *   that still exists, which reads as "your work is gone" over data that is
   *   sitting on disk.
   * - its old record reads but the fold could not classify it (a pre-kind
   *   row) → adopt it under the kind the page opened it as; the page's row is
   *   the same knowledge the fold lacked.
   * - there is no old record → a fresh document; place an empty node.
   *
   * Returns false when delivery must stop (the unreadable case).
   */
  private async placeMissingDocument(
    workspaceDoc: LoroDoc,
    handlers: DocumentBackendHandlers,
  ): Promise<boolean> {
    const { documentId, path, kind, name } = this.target
    const legacy = await this.legacy.load(documentId)
    if (
      legacy.kind === 'corrupt-snapshot' ||
      legacy.kind === 'corrupt-delta' ||
      legacy.kind === 'unsupported-version' ||
      // Refuses for the SAME reason the three above do, from the opposite
      // knowledge: they know the record is unreadable, this one knows
      // nothing. Falling through would take the "there is no old record"
      // branch below and place an empty node over a document that may be
      // sitting on disk intact — the shadowing this method exists to avoid,
      // reached by a transient IndexedDB failure.
      legacy.kind === 'read-unavailable'
    ) {
      if (!this.isStale(handlers)) handlers.onError?.(legacy.kind)
      return false
    }
    let placed: ReturnType<typeof createWorkspaceDocumentAtPath>
    if (legacy.kind === 'ok') {
      const source = new Loro()
      source.import(legacy.snapshot)
      for (const delta of legacy.deltas ?? []) source.import(delta)
      placed = adoptWorkspaceDocument(
        workspaceDoc,
        { path, documentId, kind, ...(name === undefined ? {} : { name }) },
        source,
      )
    } else {
      placed = createWorkspaceDocumentAtPath(workspaceDoc, {
        path,
        documentId,
        kind,
        ...(name === undefined ? {} : { name }),
      })
    }
    if (placed === null) {
      // Neither helper placed the target: a DIFFERENT document already owns
      // `path` (the id itself is absent, or this method was not reached).
      // Delivering anyway hands the session bytes with no node for this
      // document, which it reports as `corrupt-snapshot` — and the page
      // answers that with an offer to delete the record. Nothing is corrupt;
      // the tree has a document standing where this one wanted to.
      //
      // ponytail: `read-unavailable` is the nearest non-destructive reason —
      // it keeps the editor closed and claims nothing about the bytes — but
      // its copy implies a retry will help, and here it will not. The upgrade
      // is a reason of its own once a collision has a product answer (open
      // the document that IS there, or number this one around it).
      getAppLogger('browser-backend').warn('another document owns the target path; not placing', {
        documentId,
        path,
      })
      if (!this.isStale(handlers)) handlers.onError?.('read-unavailable')
      return false
    }
    await this.docs.save(getBrowserWorkspaceId(), workspaceDoc)
    return true
  }
}
