import type {
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
import { foldWorkspaceDocuments } from './fold-workspace.js'
import { LoroStore, touchContentTimestamp } from './loro-store.js'
import { seedNameFromTitle } from './seed-name-from-title.js'
import {
  listenToWorkspace,
  type WorkspaceBroadcast,
  type WorkspaceBroadcastEnd,
} from './workspace-broadcast.js'

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
 *
 * TOCTOU safety: all writes are serialized through a per-instance promise
 * chain (_writeQueue) so concurrent pushLocalUpdate calls import and save in
 * order.
 */
/**
 * A record this session must not place an empty node over. The first three
 * know the record is unreadable; `read-unavailable` refuses from the opposite
 * knowledge — it knows NOTHING, and falling through would take the "there is
 * no old record" branch and shadow a document that may be sitting on disk
 * intact, reached by a transient IndexedDB failure.
 */
function isUnreadableLegacyRecord(
  kind: string,
): kind is 'corrupt-snapshot' | 'corrupt-delta' | 'unsupported-version' | 'read-unavailable' {
  return (
    kind === 'corrupt-snapshot' ||
    kind === 'corrupt-delta' ||
    kind === 'unsupported-version' ||
    kind === 'read-unavailable'
  )
}

/** The node for this document: adopted from a readable legacy record, or empty. */
function placeDocumentNode(
  workspaceDoc: LoroDoc,
  target: { documentId: string; path: string; kind: DocumentKind; name?: string },
  legacy: { kind: string; snapshot?: Uint8Array; deltas?: readonly Uint8Array[] },
): ReturnType<typeof createWorkspaceDocumentAtPath> {
  const { documentId, path, kind, name } = target
  const placement = { path, documentId, kind, ...(name === undefined ? {} : { name }) }
  if (legacy.kind !== 'ok' || legacy.snapshot === undefined) {
    return createWorkspaceDocumentAtPath(workspaceDoc, placement)
  }
  const source = new Loro()
  source.import(legacy.snapshot)
  for (const delta of legacy.deltas ?? []) source.import(delta)
  return adoptWorkspaceDocument(workspaceDoc, placement, source)
}

/**
 * Merges bytes another tab sent. They passed the message schema, which says
 * only that they are bytes; a record that cannot import them logs it and
 * skips them, since throwing here would reject the write queue and stop this
 * tab's own saves.
 */
function importFromAnotherTab(workspaceDoc: LoroDoc, bytes: Uint8Array): boolean {
  try {
    workspaceDoc.import(bytes)
    return true
  } catch (err) {
    getAppLogger('browser-backend').warn('skipped an update from another tab', err)
    return false
  }
}

export class BrowserBackend implements DocumentBackend {
  private readonly target: BrowserBackendTarget
  private readonly docs: WorkspaceDocs
  private readonly legacy: LoroStore
  private handlers: DocumentBackendHandlers | null = null
  private disconnected = false
  /** The live workspace document — set once connect() has delivered it. */
  private workspaceDoc: LoroDoc | null = null
  /** Serializes all write operations (pushLocalUpdate) to prevent TOCTOU races. */
  private _writeQueue: Promise<void> = Promise.resolve()
  /** This connection's end of the record's channel to the other tabs. */
  private broadcast: WorkspaceBroadcastEnd | null = null

  constructor(target: BrowserBackendTarget, docs?: WorkspaceDocs, legacy?: LoroStore) {
    this.target = target
    this.docs = docs ?? new BrowserWorkspaceDocs()
    this.legacy = legacy ?? new LoroStore()
  }

  connect(handlers: DocumentBackendHandlers): void {
    this.closeBroadcast()
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
    this.closeBroadcast()
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
    const handlers = this.handlers
    this._writeQueue = this._writeQueue.then(() =>
      this._doWrite(bytes, workspaceDoc, workspaceId, handlers),
    )
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
        this.tellOtherTabs(await this.docs.save(workspaceId, workspaceDoc))
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

  /**
   * Change the workspace record this backend holds, and deliver the change
   * the way a peer's would arrive.
   *
   * The same shape as `applyRestore` — queued behind pending pushes so a
   * keystroke in flight is not lost under it, saved through the same store,
   * and handed to the sync session as a remote update so its twin of the
   * record converges. Two differences, both deliberate: no restore brackets,
   * because this is not a restore and a page must not draw the overlay for
   * it; and no `touchContentTimestamp`, because what this writes is not the
   * document's content.
   *
   * That last point is what makes it safe at all. A plane lives outside
   * `CONTENT_CONTAINER_KEYS` and outside `projectWorkspaceDocument`, so the
   * update produced here cannot be read back as content by the session and
   * written over by the next save — which is exactly what happened to the
   * daemon's branch tips before planes were namespaced.
   */
  mutateRecord<T>(mutate: (doc: LoroDoc, documentId: string) => T): Promise<T> {
    const workspaceDoc = this.workspaceDoc
    const workspaceId = workspaceDoc === null ? null : getBrowserWorkspaceId()
    const handlers = this.handlers
    const run = async (): Promise<T> => {
      if (workspaceDoc === null || workspaceId === null || handlers === null) {
        throw new Error('record write before the document was delivered')
      }
      const before = workspaceDoc.version()
      const result = mutate(workspaceDoc, this.target.documentId)
      const update = workspaceDoc.export({ mode: 'update', from: before })
      // A mutation that changed nothing writes nothing: the branch ops are
      // read-modify-write and several of them legitimately no-op (setHead to
      // the current head, a tip that already matches).
      if (update.length > 0) {
        this.tellOtherTabs(await this.docs.save(workspaceId, workspaceDoc))
        if (!this.isStale(handlers)) handlers.onRemoteUpdate(update)
      }
      return result
    }
    const queued = this._writeQueue.then(run)
    // The queue itself must never reject, or every later push would be
    // refused by one failed mutation.
    this._writeQueue = queued.then(
      () => {},
      () => {},
    )
    return queued
  }

  /**
   * Read the live record without writing to it, or `null` before it has been
   * delivered.
   *
   * Separate from `mutateRecord` rather than a flag on it: a read must not
   * take the write queue, and a caller that only reads should not be able to
   * write by forgetting an argument.
   */
  readRecord<T>(read: (doc: LoroDoc, documentId: string) => T): T | null {
    if (this.workspaceDoc === null) return null
    return read(this.workspaceDoc, this.target.documentId)
  }

  private async _doWrite(
    bytes: Uint8Array,
    workspaceDoc: LoroDoc | null,
    workspaceId: string | null,
    handlers: DocumentBackendHandlers | null,
  ): Promise<void> {
    // A push before the snapshot was delivered has nothing to land on — the
    // session cannot produce one, since its doc exists only after onSnapshot.
    if (workspaceDoc === null || workspaceId === null) return
    try {
      workspaceDoc.import(bytes)
      // A note is named after its body's heading while nobody has named it —
      // before the save, so the name rides the same write. No kind check: a
      // canvas has an empty body container, so it announces no title and the
      // function leaves it alone.
      const before = workspaceDoc.oplogVersion()
      seedNameFromTitle(workspaceDoc, this.target.documentId)
      const named = workspaceDoc.oplogVersion().compare(before) !== 0
      this.tellOtherTabs(await this.docs.save(workspaceId, workspaceDoc))
      // The session never READS the name, but it must HOLD those ops: every
      // later edit anywhere depends on them, and a doc missing a dependency
      // keeps that edit pending — another tab's typing never appeared here.
      if (named && handlers !== null && !this.isStale(handlers)) {
        handlers.onRemoteUpdate(workspaceDoc.export({ mode: 'update', from: before }))
      }
      // The listing's updatedAt: stamped per push, keyed by the document this
      // backend serves — the workspace document itself has no row to stamp.
      await touchContentTimestamp(this.target.documentId)
    } catch {
      this.handlers?.onError?.('storage-failure')
    }
  }

  /** No WebSocket in browser mode. */
  sendClientReady(): void {
    /* no-op */
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /** True once the original connect() handlers are no longer the live ones. */
  private isStale(handlers: DocumentBackendHandlers): boolean {
    return this.disconnected || this.handlers !== handlers
  }

  /** What this tab persisted, for the other tabs holding the record. */
  private tellOtherTabs(persisted: Uint8Array | null): void {
    if (persisted !== null) this.broadcast?.post({ type: 'update', bytes: persisted })
  }

  /**
   * Closed only once the writes already queued have run: a push made just
   * before a switch is still saved after it, and the other tabs still need
   * to hear about it.
   */
  private closeBroadcast(): void {
    const end = this.broadcast
    if (end === null) return
    void this._writeQueue.then(() => {
      end.close()
      if (this.broadcast === end) this.broadcast = null
    })
  }

  /**
   * Another tab's saved update merges here the way a peer's does over the
   * daemon's socket: into this backend's copy, then to the session as a
   * remote update. Never saved again — the record already holds it. Queued
   * so it lands between this tab's own writes, never inside a restore.
   */
  private receive(
    message: WorkspaceBroadcast,
    workspaceDoc: LoroDoc,
    handlers: DocumentBackendHandlers,
  ): void {
    if (this.isStale(handlers)) return
    if (message.type === 'version-created') {
      if (message.documentId === this.target.documentId) handlers.onVersionCreated(message.version)
      return
    }
    this._writeQueue = this._writeQueue.then(() => {
      if (this.isStale(handlers)) return
      if (importFromAnotherTab(workspaceDoc, message.bytes)) handlers.onRemoteUpdate(message.bytes)
    })
  }

  /**
   * Opens the channel BEFORE the record is read, holding what arrives until
   * the record is in hand. A tab's broadcast reaches only the ends open when
   * it posts, so listening after the read missed any save that landed between
   * the two — in neither the snapshot nor a message. The held updates are
   * merged into the record before it is delivered; one the snapshot already
   * has is a no-op, since import is idempotent.
   *
   * ponytail: a delivery that never happens (the record failed to open)
   * keeps holding until the next connect or disconnect closes the end.
   */
  private hearFromTheStart(
    workspaceId: string,
    handlers: DocumentBackendHandlers,
  ): (workspaceDoc: LoroDoc) => void {
    const held: Uint8Array[] = []
    let delivered: LoroDoc | null = null
    this.broadcast = listenToWorkspace(workspaceId, (message) => {
      if (delivered !== null) this.receive(message, delivered, handlers)
      else if (message.type === 'update') held.push(message.bytes)
    })
    return (workspaceDoc) => {
      for (const bytes of held.splice(0)) importFromAnotherTab(workspaceDoc, bytes)
      delivered = workspaceDoc
    }
  }

  /**
   * Any per-document records first fold into the tree, so a document created
   * by an older build is served from the same place as everything else.
   * Derived work list — a second connect finds nothing pending. Non-fatal on
   * failure: the fold retries at the next connect, and `placeMissingDocument`
   * still classifies this backend's own document — degrading the open over a
   * fold hiccup would take the whole editor down for a step that is only
   * migration.
   */
  private async foldLegacyRecords(): Promise<void> {
    try {
      await foldWorkspaceDocuments()
    } catch (err) {
      getAppLogger('browser-backend').warn('startup fold failed; continuing without it', err)
    }
  }

  private async loadAndDeliver(handlers: DocumentBackendHandlers): Promise<void> {
    await this.foldLegacyRecords()
    if (this.isStale(handlers)) return

    const workspaceId = getBrowserWorkspaceId()
    const hear = this.hearFromTheStart(workspaceId, handlers)
    let workspaceDoc: LoroDoc
    try {
      workspaceDoc = await this.docs.create(workspaceId)
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

    this.deliver(workspaceDoc, hear, handlers)
  }

  /** Hands the record to the session, with what the other tabs saved meanwhile. */
  private deliver(
    workspaceDoc: LoroDoc,
    hear: (workspaceDoc: LoroDoc) => void,
    handlers: DocumentBackendHandlers,
  ): void {
    this.workspaceDoc = workspaceDoc
    hear(workspaceDoc)
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
    const legacy = await this.legacy.load(this.target.documentId)
    if (isUnreadableLegacyRecord(legacy.kind)) {
      if (!this.isStale(handlers)) handlers.onError?.(legacy.kind)
      return false
    }
    const placed = placeDocumentNode(workspaceDoc, this.target, legacy)
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
        documentId: this.target.documentId,
        path: this.target.path,
      })
      if (!this.isStale(handlers)) handlers.onError?.('read-unavailable')
      return false
    }
    await this.docs.save(getBrowserWorkspaceId(), workspaceDoc)
    return true
  }
}
