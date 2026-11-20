import type {
  DocumentBackend,
  DocumentBackendHandlers,
  SyncWriteRefusal,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  lease,
  type RecordLease,
  SYNC_TEXT_BREACH_CODES,
  SYNC_WORKSPACE_BREACH_CODES,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  base64ToBytes,
  bytesToBase64,
  type DocumentKind,
  type documentEngine as wire,
} from '@kamiazya/whiteboard-model'
import { isStoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import type { WorkspaceDocCursor, WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { z } from 'zod'
import { getAppLogger } from './app-logger.js'
import { saveAndAnnounce } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { BrowserWorkspaceRecords } from './browser-workspace-records.js'
import { touchContentTimestamp } from './content-timestamp.js'
import {
  listenToWorkspace,
  type WorkspaceBroadcast,
  type WorkspaceBroadcastEnd,
} from './workspace-broadcast.js'
import { documentIdsInRecord } from './workspace-record-ids.js'
import { isWorkspaceRemovedError } from './workspace-tombstone.js'

/**
 * The document a BrowserBackend serves. `path`/`kind`/`name` are what connect
 * needs to place the document in the workspace tree when it is not there yet
 * — the page already holds all three from the index row it loaded.
 */
export interface BrowserBackendTarget {
  documentId: string
  path: string
  kind: DocumentKind
  name?: string
}

/**
 * The refusal the daemon answers the same breach with. No sentence of its own:
 * the notice says why from the code alone, so text written here would be read
 * by nobody, and the breach itself is in the log line beside it.
 */
function refusalOf(breach: wire.Breach): SyncWriteRefusal {
  // The engine names the shape across both judges' vocabularies; a text judge
  // only ever answers the first table.
  const codes: Readonly<Record<string, SyncWriteRefusal['code']>> = {
    ...SYNC_TEXT_BREACH_CODES,
    ...SYNC_WORKSPACE_BREACH_CODES,
  }
  return { code: codes[breach.shape] ?? 'invalid_document_root', message: '' }
}

/**
 * Merges bytes another tab sent. They passed the message schema, which says
 * only that they are bytes; a record that cannot import them logs it and
 * skips them, since throwing here would reject the write queue and stop this
 * tab's own saves.
 */
function importFromAnotherTab(
  record: RecordLease,
  bytes: Uint8Array,
): 'merged' | 'pending' | 'skipped' {
  try {
    const result = lease.importBytes(record, bytes, 'none')
    return result.outcome === 'applied' && result.pending === true ? 'pending' : 'merged'
  } catch (err) {
    getAppLogger('browser-backend').warn('skipped an update from another tab', err)
    return 'skipped'
  }
}

/**
 * A position no stored record is at — a generation is a count — so the first
 * catch-up re-reads the whole record. Taking a real cursor when the record is
 * opened would cost every open a read for the sake of a rename that may never
 * come; a whole read, once, is merged idempotently.
 */
const WHOLE_RECORD: WorkspaceDocCursor = { generation: Number.NaN, afterSeq: null }

/** The bytes of the update a call made, or null when it changed nothing. */
function updateOf(result: wire.MutationResult): Uint8Array | null {
  if (result.outcome !== 'applied' || result.localUpdate === undefined) return null
  const bytes = base64ToBytes(result.localUpdate)
  return bytes === null || bytes.length === 0 ? null : bytes
}

/**
 * The keeper has judged what it is writing itself, so the write makes no
 * judging copy of a record that holds every document.
 */
function writeUnjudged(record: RecordLease, batch: wire.Write[]): Uint8Array | null {
  return updateOf(lease.write(record, batch, { judge: 'none' }))
}

const entryShape = z.custom<unknown>()

async function holdsDocument(record: RecordLease, documentId: string): Promise<boolean> {
  const entry = await lease.read(
    record,
    { query: 'workspaceDocumentEntry', args: { documentId } },
    entryShape,
  )
  return entry !== null
}

/**
 * BrowserBackend: DocumentBackend implementation for fully offline, browser
 * use — backed by the WORKSPACE document.
 *
 * The bytes this backend delivers and persists are one record holding every
 * document the browser keeps, each as a workspace-tree node
 * (`docRefKey({kind:'workspace-tree'})` in the same IndexedDB stores). The
 * backend holds that record as an engine lease and the sync session holds a
 * document of its own built from the snapshot it is handed: what crosses is
 * bytes in both directions (a local update in, a remote update out), never a
 * shared document. The session edits through its content scope
 * (`SessionDeps.contentDocumentId`), so a local update's ops land on this
 * document's tree node. Persistence is the shared incremental shape
 * (`DocumentStoreWorkspaceDocs.save`): append a delta per push, fold when the
 * log passes the budget, never write when nothing changed.
 *
 * The lease is released once the writes already queued have run, on
 * disconnect, on a reconnect and on every load that does not deliver.
 *
 * TOCTOU safety: all writes are serialized through a per-instance promise
 * chain (_writeQueue) so concurrent pushLocalUpdate calls import and save in
 * order.
 */
export class BrowserBackend implements DocumentBackend {
  private readonly target: BrowserBackendTarget
  private readonly docs: WorkspaceDocs<RecordLease>
  private handlers: DocumentBackendHandlers | null = null
  private disconnected = false
  /** The live workspace record — set once connect() has delivered it. */
  private record: RecordLease | null = null
  /**
   * The workspace that record is the record of, read once with it. Never
   * the active id read again later: the active id moves on a switch or a
   * removal, and this copy written under another id is that whole workspace
   * minted somewhere it does not belong.
   */
  private workspaceId: string | null = null
  /** The workspace left this browser: nothing more is written, and the page has been told. */
  private removed = false
  /** Serializes all write operations (pushLocalUpdate) to prevent TOCTOU races. */
  private _writeQueue: Promise<void> = Promise.resolve()
  /** This connection's end of the record's channel to the other tabs. */
  private broadcast: WorkspaceBroadcastEnd | null = null
  /** How far into the stored record a catch-up has read this copy; null before the first. */
  private cursor: WorkspaceDocCursor | null = null

  constructor(target: BrowserBackendTarget, docs?: WorkspaceDocs<RecordLease>) {
    this.target = target
    this.docs = docs ?? new BrowserWorkspaceRecords()
  }

  connect(handlers: DocumentBackendHandlers): void {
    this.closeBroadcast()
    this.releaseRecord()
    this.disconnected = false
    this.handlers = handlers
    this.workspaceId = null
    this.removed = false
    this.cursor = null
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
    this.workspaceId = null
    this.releaseRecord()
    this.closeBroadcast()
  }

  /**
   * Accept a local Loro update — ops against the WORKSPACE document. Imported
   * into the record this backend holds (idempotent, so the reconnect
   * full-state re-send merges as a no-op) and persisted through the shared
   * incremental save. Writes are chained onto _writeQueue so two concurrent
   * calls apply in order with no lost update.
   */
  pushLocalUpdate(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return Promise.resolve()
    // Both the record and the WORKSPACE are captured here, at enqueue, not
    // read again when the queued write runs. What runs later runs after
    // whatever else happened in between, and two things can happen:
    //
    // - `disconnect()` lets go of the record synchronously, so a write still
    //   on the queue would find nothing to land on and return — dropping
    //   the edit the person had just made. A workspace switch unmounts the
    //   session at exactly that moment. (The lease itself is released only
    //   after the queue has run.)
    // - The active workspace is re-pointed by the address, so reading
    //   `getBrowserWorkspaceId()` late would file these bytes under the workspace
    //   being switched TO. Losing an edit is bad; putting it in another
    //   workspace is worse — which is also why the id is the one the record
    //   was loaded under, never the active one.
    const record = this.record
    const workspaceId = this.workspaceId
    const handlers = this.handlers
    this._writeQueue = this._writeQueue.then(() =>
      this._doWrite(bytes, record, workspaceId, handlers),
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
   * (`writeDocumentContentAndName`, a diff and never a rewrite) runs on
   * the record, the ops it produced are persisted, and those ops reach the
   * session the way a peer's would: as a remote update. Nothing rewinds in
   * a CRDT; the session's own later ops stay in its history and the restore
   * is one more edit on top of them. The note is named after the heading it
   * was restored to, as the daemon's restore names it.
   *
   * `past` is the document's content as a document of its own, content at the
   * root: the projection's bytes.
   *
   * Bracketed with the restore events the daemon sends, so a page that
   * renders the restore overlay for a daemon restore renders it here too.
   * Queued behind pending pushes so a keystroke in flight is reconciled
   * over, not lost under, the restore.
   */
  applyRestore(past: Uint8Array, label?: string): Promise<void> {
    const record = this.record
    const workspaceId = this.workspaceId
    const handlers = this.handlers
    const run = async (): Promise<void> => {
      if (record === null || workspaceId === null || handlers === null) {
        throw new Error('restore before the document was delivered')
      }
      handlers.onRestoreStarted(label === undefined ? {} : { label })
      try {
        const update = writeUnjudged(record, [
          {
            op: 'writeDocumentContentAndName',
            args: { documentId: this.target.documentId, source: bytesToBase64(past) },
          },
        ])
        await this.saveAndTellOtherTabs(workspaceId, record)
        await touchContentTimestamp(this.target.documentId)
        if (update !== null && !this.isStale(handlers)) handlers.onRemoteUpdate(update)
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
   * Lend the live record to `read` without writing to it, or `null` before it
   * has been delivered. The lease is the backend's own: `read` must not keep
   * it past the call, and a read that answers a promise has begun by the time
   * it returns.
   *
   * A read does not take the write queue.
   */
  readRecord<T>(read: (record: RecordLease, documentId: string) => T): T | null {
    if (this.record === null) return null
    return read(this.record, this.target.documentId)
  }

  private async _doWrite(
    bytes: Uint8Array,
    record: RecordLease | null,
    workspaceId: string | null,
    handlers: DocumentBackendHandlers | null,
  ): Promise<void> {
    // A push before the snapshot was delivered has nothing to land on — the
    // session cannot produce one, since its doc exists only after onSnapshot.
    if (record === null || workspaceId === null || this.removed) return
    try {
      // Refused before it lands: once imported, the bytes would ride the next
      // save whatever this one decided. Judged whatever the kind — a canvas's
      // node text, labels and comment messages are bounded as a note's body
      // is, and a record holding one past its bound is one the daemon refuses
      // to take on promotion.
      const imported = lease.importBytes(record, bytes, 'text')
      if (imported.outcome === 'refused') {
        getAppLogger('browser-backend').warn('refused an update past a text limit', {
          documentId: this.target.documentId,
          ...imported.breach,
        })
        this.refuse(refusalOf(imported.breach), record, handlers)
        return
      }
      // A note is named after its body's heading while nobody has named it —
      // before the save, so the name rides the same write. No kind check: a
      // canvas has an empty body container, so it announces no title and the
      // writer leaves it alone.
      const naming = writeUnjudged(record, [
        { op: 'seedNameFromTitle', args: { documentId: this.target.documentId } },
      ])
      await this.saveAndTellOtherTabs(workspaceId, record)
      // The session reads the name (the open page's title follows it), and it
      // must HOLD those ops either way: every later edit anywhere depends on
      // them, and a doc missing a dependency keeps that edit pending.
      if (naming !== null && handlers !== null && !this.isStale(handlers)) {
        handlers.onRemoteUpdate(naming)
      }
      // The listing's updatedAt: stamped per push, keyed by the document this
      // backend serves — the workspace document itself has no row to stamp.
      await touchContentTimestamp(this.target.documentId)
    } catch (err) {
      if (isWorkspaceRemovedError(err)) this.withdraw(record, handlers)
      else this.handlers?.onError?.('storage-failure')
    }
  }

  /**
   * The workspace left this browser while this page held it. The session
   * locks on its document leaving the record it holds, so that is what it is
   * handed: the node's removal, as a remote update. Only this copy changes —
   * nothing is saved, and nothing is written again.
   */
  private withdraw(record: RecordLease, handlers: DocumentBackendHandlers | null): void {
    if (this.removed) return
    this.removed = true
    if (handlers === null || this.isStale(handlers)) return
    const removal = writeUnjudged(record, [
      { op: 'deleteWorkspaceDocument', args: { documentId: this.target.documentId } },
    ])
    if (removal !== null) handlers.onRemoteUpdate(removal)
  }

  /**
   * The session is told why, then handed the record as it stands. Every edit
   * it makes after the refused one is built on the refused ops, so carrying
   * on from its own copy would land none of them — each would import here as
   * pending, change nothing, and still be saved as if it had.
   */
  private refuse(
    refusal: SyncWriteRefusal,
    record: RecordLease,
    handlers: DocumentBackendHandlers | null,
  ): void {
    if (handlers === null || this.isStale(handlers)) return
    handlers.onWriteRefused?.(refusal)
    handlers.onSnapshot(lease.exportSnapshot(record))
  }

  /** A workspace kept in the browser has no sync stream to announce readiness to. */
  sendClientReady(): void {
    /* no-op */
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /** True once the original connect() handlers are no longer the live ones. */
  private isStale(handlers: DocumentBackendHandlers): boolean {
    return this.disconnected || this.handlers !== handlers
  }

  /** Persists the record and hands what it wrote to the other tabs holding it. */
  private async saveAndTellOtherTabs(workspaceId: string, record: RecordLease): Promise<void> {
    await saveAndAnnounce(this.docs, workspaceId, record, this.broadcast)
  }

  /**
   * Gives the record back once the writes already queued have run: a push
   * made just before a switch is still imported and saved after it.
   */
  private releaseRecord(): void {
    const held = this.record
    if (held === null) return
    this.record = null
    const release = () => held.release()
    void this._writeQueue.then(release, release)
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
    workspaceId: string,
    record: RecordLease,
    handlers: DocumentBackendHandlers,
  ): void {
    if (this.isStale(handlers)) return
    if (message.type === 'workspace-removed') {
      this._writeQueue = this._writeQueue.then(() => this.withdraw(record, handlers))
      return
    }
    if (message.type === 'version-created') {
      if (message.documentId === this.target.documentId) handlers.onVersionCreated(message.version)
      return
    }
    // A removal or a restore names a PATH — this document's, a folder above
    // it, or neither once a move has left this backend's own path stale — so
    // whether this document is in the record is the record's to say, and any
    // of either catches up.
    const catchUp =
      message.type === 'document-removed' ||
      message.type === 'document-restored' ||
      (message.type === 'document-renamed' && message.documentId === this.target.documentId)
    if (catchUp) {
      this._writeQueue = this._writeQueue.then(() =>
        this.catchUpWithStore(workspaceId, record, handlers),
      )
      return
    }
    // Path changes are for whoever holds work keyed by path, not for the record.
    if (message.type !== 'update') return
    this._writeQueue = this._writeQueue.then(async () => {
      if (this.isStale(handlers)) return
      const merged = importFromAnotherTab(record, message.bytes)
      if (merged === 'skipped') return
      handlers.onRemoteUpdate(message.bytes)
      // Bytes that build on record writes this copy never received — the
      // index's create, move or pin, whose saves announce no bytes — stay
      // pending until it has them, and the record does.
      if (merged === 'pending') await this.catchUpWithStore(workspaceId, record, handlers)
    })
  }

  /**
   * Merges what the stored record gained since this copy last read it, and
   * hands it on to the session. A rename, delete or restore is written by
   * the index, whose save travels to nobody — and the name this keeper seeds
   * from a heading is judged against THIS copy, so a copy that never saw the
   * name somebody chose named the note over it, one that never saw the delete
   * kept saving into a node that was gone, and one that never saw the restore
   * stayed locked over a document that was back. Queued like any write, and
   * it never rejects the queue: a catch-up that failed leaves the copy where
   * it was.
   */
  private async catchUpWithStore(
    workspaceId: string,
    record: RecordLease,
    handlers: DocumentBackendHandlers,
  ): Promise<void> {
    if (this.isStale(handlers)) return
    try {
      const caught = await this.docs.catchUp(workspaceId, record, this.cursor ?? WHOLE_RECORD)
      this.cursor = caught.cursor
      if (this.isStale(handlers)) return
      for (const update of caught.updates) handlers.onRemoteUpdate(update)
    } catch (err) {
      getAppLogger('browser-backend').warn('catching up with the stored record failed', err)
    }
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
  ): (record: RecordLease) => void {
    const held: Uint8Array[] = []
    let delivered: RecordLease | null = null
    this.broadcast = listenToWorkspace(workspaceId, (message) => {
      if (delivered !== null) this.receive(message, workspaceId, delivered, handlers)
      else if (message.type === 'update') held.push(message.bytes)
    })
    return (record) => {
      for (const bytes of held.splice(0)) importFromAnotherTab(record, bytes)
      delivered = record
    }
  }

  private async loadAndDeliver(handlers: DocumentBackendHandlers): Promise<void> {
    const workspaceId = getBrowserWorkspaceId()
    const hear = this.hearFromTheStart(workspaceId, handlers)
    let record: RecordLease
    try {
      record = await this.docs.create(workspaceId)
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
        handlers.onError?.(readFailureReason(err))
      }
      getAppLogger('browser-backend').warn('opening the workspace record failed', err)
      return
    }
    let delivered = false
    try {
      if (this.isStale(handlers)) return
      if (!(await holdsDocument(record, this.target.documentId))) {
        const settled = await this.placeMissingDocument(workspaceId, record, handlers)
        if (!settled) return
      }
      if (this.isStale(handlers)) return
      this.deliver(workspaceId, record, hear, handlers)
      delivered = true
    } finally {
      if (!delivered) record.release()
    }
  }

  /** Hands the record to the session, with what the other tabs saved meanwhile. */
  private deliver(
    workspaceId: string,
    record: RecordLease,
    hear: (record: RecordLease) => void,
    handlers: DocumentBackendHandlers,
  ): void {
    this.record = record
    this.workspaceId = workspaceId
    hear(record)
    handlers.onSnapshot(lease.exportSnapshot(record))
  }

  /**
   * The document is not in the tree: a document the page resolved from an
   * index with no record behind it, placed as an empty node.
   *
   * Unless the record already answers for the id: then it is in the trash —
   * deleted after the page resolved it — and a node placed here would stand
   * beside the trashed copy and turn its restore into a second node under one
   * id. `read-unavailable` for the reason the path collision below gives.
   *
   * Returns false when delivery must stop (the trashed and collision cases).
   */
  private async placeMissingDocument(
    workspaceId: string,
    record: RecordLease,
    handlers: DocumentBackendHandlers,
  ): Promise<boolean> {
    if ((await documentIdsInRecord(record)).has(this.target.documentId)) {
      getAppLogger('browser-backend').warn('the trash holds this document; not placing', {
        documentId: this.target.documentId,
      })
      if (!this.isStale(handlers)) handlers.onError?.('read-unavailable')
      return false
    }
    const { documentId, path, kind, name } = this.target
    writeUnjudged(record, [
      {
        op: 'createWorkspaceDocumentAtPath',
        args: { path, documentId, kind, ...(name === undefined ? {} : { name }) },
      },
    ])
    if (!(await holdsDocument(record, documentId))) {
      // The target was not placed: a DIFFERENT document already owns
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
    await this.saveAndTellOtherTabs(workspaceId, record)
    return true
  }
}

/**
 * A retired envelope is intact data in a shape this build stopped reading, so
 * it must never take `corrupt-snapshot`, whose recovery deletes the record.
 */
function readFailureReason(
  err: unknown,
): 'retired-stored-shape' | 'corrupt-snapshot' | 'read-unavailable' {
  if (!isStoredDocumentUnreadableError(err)) return 'read-unavailable'
  return err.code === 'retired-envelope' ? 'retired-stored-shape' : 'corrupt-snapshot'
}
