/**
 * Single opener for the shared 'whiteboard' IndexedDB, used by both
 * browser-backend.ts (JSON 'documents' metadata) and loro-store.ts
 * (canonical 'loroDocuments' CRDT records). Both stores live in the same
 * database, so a version bump or upgrade change to one that isn't mirrored in
 * the other produces a VersionError the next time the stale opener runs.
 * Owning DB_VERSION and onupgradeneeded in one place makes that impossible by
 * construction instead of relying on a hand-synced comment.
 */
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { loroRecordEnvelopeSchema } from './loro-record-envelope.js'

const DB_NAME = 'whiteboard'

// The name every opener below resolves when its caller passes none. Module
// state, not a parameter, because page-level browser tests mount whole pages
// that construct their stores internally — no argument can reach them.
// Browser test files each run in their own page with their own module graph,
// so setting this in one file cannot leak into another; what IS shared across
// files is the origin's IndexedDB itself, which is exactly why every file
// must claim its own name instead of deleting the shared one out from under
// its neighbours.
let activeDbName = DB_NAME

/**
 * Point this page's openers at a private database. Test seam, same shape as
 * `openWhiteboardDb(dbName?)`: production never calls it. See
 * `test-utils/isolated-whiteboard-db.ts` for the helper tests actually use.
 */
export function setWhiteboardDbNameForTests(name: string): void {
  activeDbName = name
}

/** The database name this page's openers currently resolve. */
export function whiteboardDbName(): string {
  return activeDbName
}

/**
 * The database name is a parameter so a test can have one of its own. Browser
 * tests share an origin, so two FILES touching `whiteboard` interleave: a
 * suite that deletes the database between cases will do so while another file
 * is seeding a fixture into it, and the failure lands in the file that did
 * nothing wrong. Production has exactly one name and never passes this.
 */

/**
 * v2 -> v3: elements are canonical in the Loro doc; the JSON metadata row is
 * demoted to metadata only (id/name/updatedAt). Any legacy 'scene' field left
 * over from a pre-v3 row is stripped during upgrade so no old-schema shape
 * survives to fail documentSnapshotSchema.parse.
 *
 * v3 -> v4: additive — adds the uploaded-image Blob store (see
 * document-file-store.ts). Existing data is untouched.
 *
 * v4 -> v5: additive — added the 'reconnectKeypairs' object store (WebCrypto
 * ECDSA P-256 keypairs for silent-reconnect).
 *
 * v5 -> v6: REMOVES the 'reconnectKeypairs' object store. Unattended
 * reconnect is gone (see docs/explanation/security-model.md): a process
 * that takes over this origin's port inherits everything in this origin's
 * storage, and a non-extractable CryptoKey does not need to be exfiltrated
 * to be abused — same-origin script can call crypto.subtle.sign() with it
 * directly. Deleting the store (not just abandoning it) is the point: a
 * credential no longer read but still stored is still stealable. The
 * companion plaintext secret this store's credential redeemed
 * (localStorage['whiteboard.reconnect-secret.v1']) is purged separately by
 * purge-legacy-reconnect-credentials.ts, since a localStorage key is not
 * reachable from this IndexedDB upgrade transaction.
 *
 * v6 -> v7: renames the three stores that spelled the CONTAINER `canvas`,
 * which ADR-0009 calls a Document — 'canvases' -> 'documents',
 * 'loroCanvases' -> 'loroDocuments', 'canvasFiles' -> 'documentFiles' — plus
 * the 'meta' pointer key 'defaultCanvasId' -> 'defaultDocumentId'.
 * IndexedDB has no rename, so each store is created, copied record by record,
 * and the old one deleted once its cursor is exhausted. The pre-v3 'scene'
 * strip is folded into that copy rather than kept as a separate pass: it is a
 * guarded no-op on every v3+ row, and running it inside the copy avoids two
 * cursors contending over the same source store.
 *
 * v7 -> v8: DISCARDS every document row that predates workspace+path
 * addressing. A pre-v8 row carries only `{id, name, updatedAt, kind}` — no
 * workspace, no path, and a `crypto.randomUUID()` id the model's canonical
 * ULID schema refuses — so there is nothing to migrate it TO without
 * inventing an address, and an invented address is worse than none: it is
 * indistinguishable from one the user chose. Local documents are discardable
 * by explicit decision (0.0.x, no users), so the row and its Loro record are
 * deleted outright, and the default pointer is cleared when it named one of
 * them. Deleting the bytes matters as much as the row: a Loro record no
 * document names is unreachable storage nothing would ever collect.
 *
 * v8 -> v9: adds the two stores behind the browser's `DocumentIndex` port
 * implementation — `workspaces` (keyed by workspaceId) and `documentIndex`
 * (keyed by the pair `[workspaceId, path]`, with a unique `byId` index on
 * `[workspaceId, documentId]`). Purely additive; the bespoke `documents`
 * store keeps serving `browser-backend.ts` until its call sites move.
 *
 * The compound keys are the schema doing the work rather than the code: the
 * primary key IS the uniqueness rule `createDocument` has to enforce, so
 * claiming a path is one `add()` that fails on conflict rather than a read
 * followed by a write two callers could interleave.
 *
 * v9 -> v10: backfills those two stores from the bespoke `documents` store
 * and then drops it. v9 created them empty on the promise that `documents`
 * would keep serving reads "until its call sites move"; this is that move.
 * The row shapes already agree — v8 left every surviving row carrying a
 * `workspaceId` and a `path` — so the backfill is a copy, not a conversion.
 * The `workspaces` row is written even when there is nothing to copy: the
 * port answers a list against an unknown workspace with an error rather than
 * an empty list, so a user who had no documents must still get a workspace or
 * their first visit reads as a failure.
 *
 * v10 -> v11: adds `blobs`, the `BlobStore` port's store — content-addressed
 * bytes keyed by `<algorithm>:<digestHex>`. Purely additive, and nothing is
 * migrated INTO it: `documentFiles` keeps its own records and gains a
 * fileId -> ref mapping beside them, because the fileId a document embeds is
 * a published address (the daemon's file route validates it) and is not this
 * increment's to change.
 *
 * v11 -> v12: adds `syncDocuments`, the `DocumentStore` port's store. One
 * record per `docRefKey`, holding the snapshot manifest, its chunk bytes, the
 * frontier and the delta log together — the daemon spreads the same state
 * across four SQL tables because a row is the unit there, and a record is the
 * unit here, so one `readwrite` transaction over one key gives the port's
 * atomicity without a join.
 *
 * Purely additive, and deliberately NOT where `LoroStore` writes: that store
 * keeps `loroDocuments` until its callers move, and two writers on one shape
 * during a transition is how a subtle corruption gets in.
 *
 * v12 -> v13: moves a snapshot's chunk BYTES out of the `syncDocuments`
 * record into their own store, `syncSnapshotChunks`, keyed by the pair
 * `[docRefKey, chunkIndex]`. The record keeps the manifest and becomes
 * envelope v2.
 *
 * v12 put them together for atomicity, which one record does buy. What it also
 * bought is a read of the whole snapshot on every edit: `appendDeltas` reads
 * the record to append to its delta log, and IndexedDB has no partial `get`,
 * so appending 88 bytes deserialized however many megabytes the document had
 * grown to. Two stores in one `readwrite` transaction keep the atomicity and
 * charge the append only for what it touches.
 *
 * Cross-tab upgrades are handled rather than accepted from v8 on: every
 * connection this module opens closes itself on `versionchange`, so a newer
 * tab's upgrade is not blocked by an older one sitting idle, and a block that
 * happens anyway (a tab still running a pre-v8 bundle) rejects with a
 * message a caller can show instead of hanging on a request that never
 * settles.
 *
 * v13 -> v14: re-keys the browser's single workspace off the literal string
 * `'local'` onto a canonical ULID (ADR-0019's browser-keeper half — the
 * daemon keeper is a separate lane). `'local'` was never a valid
 * `workspaceCanonicalIdSchema` value; it survived as a stand-in because
 * nothing before this needed the two keepers' workspace ids to share a
 * shape. See `rekeyBrowserWorkspace` for why this cannot be a plain
 * rename-and-done.
 */
export const DB_VERSION = 14

/** The `DocumentIndex` port's two stores. Exported so the implementation and
 * the opener cannot disagree about a name. */
export const WORKSPACES_STORE = 'workspaces'
export const DOCUMENT_INDEX_STORE = 'documentIndex'

/** The `BlobStore` port's store. Keyed by `<algorithm>:<digestHex>` — the ref
 * IS the key, which is what makes the store deduplicating by construction. */
export const BLOBS_STORE = 'blobs'

/** Where a document's file references live: fileId -> BlobRef. */
export const DOCUMENT_FILES_STORE = 'documentFiles'

/** The `DocumentStore` port's store, keyed by `docRefKey`. Holds a document's
 * snapshot MANIFEST, frontier and delta log — never the snapshot's bytes. */
export const SYNC_DOCUMENTS_STORE = 'syncDocuments'

/**
 * The snapshot bytes those manifests describe, keyed by `[docRefKey, index]`.
 *
 * A separate store rather than a separate field, because the cost this splits
 * is IndexedDB's `get`: a record comes back whole or not at all, so any read of
 * a document's delta log paid for its snapshot too. A compound key gives each
 * chunk its own value while keeping a document's chunks contiguous, so
 * replacing or deleting a snapshot is one ranged operation.
 */
export const SYNC_SNAPSHOT_CHUNKS_STORE = 'syncSnapshotChunks'

/**
 * When a document's content was last written, keyed by documentId.
 *
 * Its own store because it belongs to neither port. `DocumentStore` has no
 * notion of wall-clock time — a frontier is the only ordering it knows — and
 * `DocumentIndex` deliberately holds only placement and naming. This is the
 * third app-side concern beside the default-document pointer and the content
 * clock that reads it, and it lives where those do: outside the contracts.
 */
export const CONTENT_TIMESTAMPS_STORE = 'contentTimestamps'

/**
 * The chunk size the v12 migration writes its carried snapshots with.
 *
 * Frozen here rather than read from `LoroStore`: a migration's numbers are
 * the ones it RAN with, and a later change to what the app chunks at must not
 * retroactively change what an already-migrated record claims about itself.
 */
const LEGACY_MAX_CHUNK_BYTES = 1_000_000

const RENAMED_STORES: readonly (readonly [from: string, to: string])[] = [
  ['canvases', 'documents'],
  ['loroCanvases', 'loroDocuments'],
  ['canvasFiles', 'documentFiles'],
]

/**
 * Copies every record of `from` into `to`, then deletes `from`.
 *
 * The delete is deferred to the cursor's terminal callback on purpose:
 * `deleteObjectStore` is legal at any point in a versionchange transaction,
 * but calling it while the copy's cursor is still walking would kill the
 * source out from under the requests that have not run yet.
 */
function copyStoreThenDelete(
  db: IDBDatabase,
  tx: IDBTransaction,
  from: string,
  to: string,
  onDone: () => void,
): void {
  if (!db.objectStoreNames.contains(from)) {
    onDone()
    return
  }
  const source = tx.objectStore(from)
  const target = tx.objectStore(to)
  const cursorReq = source.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      db.deleteObjectStore(from)
      onDone()
      return
    }
    target.put(stripLegacySceneField(cursor.value), cursor.key)
    cursor.continue()
  }
}

/**
 * Drops the pre-v3 `scene` field a metadata row must not carry. Guarded
 * against a non-object row: a corrupt value would otherwise throw a TypeError
 * out of the `in` check, aborting the upgrade transaction and bricking the DB
 * open.
 */
function stripLegacySceneField(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('scene' in value)) return value
  const { scene: _scene, ...metadataOnly } = value as Record<string, unknown>
  return metadataOnly
}

/**
 * True for a row already addressed the way v8 stores one.
 *
 * Written out rather than delegating to `documentSnapshotSchema`: a migration
 * has to keep meaning what it meant on the day it ran, and a live schema is
 * free to gain a required field later, which would silently turn this into a
 * discard of rows it was never meant to touch. Guarded against a non-object
 * value — a corrupt row must not throw out of an upgrade transaction, which
 * would abort it and brick the database open.
 */
function isPathAddressed(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.documentId === 'string' &&
    typeof row.workspaceId === 'string' &&
    typeof row.path === 'string'
  )
}

function discardPrePathDocuments(tx: IDBTransaction, done: () => void): void {
  const documents = tx.objectStore('documents')
  const loro = tx.objectStore('loroDocuments')
  const meta = tx.objectStore('meta')
  const cursorReq = documents.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      done()
      return
    }
    if (!isPathAddressed(cursor.value)) {
      const key = cursor.primaryKey
      cursor.delete()
      loro.delete(key)
      // Cleared only when it named THIS row: a blanket clear would log a user
      // out of the documents that survive.
      const pointer = meta.get('defaultDocumentId')
      pointer.onsuccess = () => {
        if (pointer.result === key) meta.delete('defaultDocumentId')
      }
    }
    cursor.continue()
  }
}

/**
 * Copies every surviving `documents` row into the `DocumentIndex` stores, then
 * drops `documents`.
 *
 * The workspace rows come from the documents themselves rather than from a
 * hardcoded `'local'`: this store never held more than one workspace, but
 * reading it from the data is the version that stays correct if it ever did.
 * The literal `'local'` key below is still written unconditionally on every
 * upgrade — `rekeyBrowserWorkspace` (v13->v14, further down) is what absorbs
 * it onto the canonical id the browser UI actually opens.
 */
/**
 * Moves every Loro content record into the `DocumentStore` port's store, and
 * its `updatedAt` into the content-timestamp store, then drops the old one.
 *
 * A copy, not a conversion: the snapshot bytes go across unchanged, wrapped in
 * the manifest `chunkSnapshot` derives for them. That derivation is a pure,
 * SYNCHRONOUS function of the bytes and a chunk size, which is what makes this
 * a migration the upgrade transaction can run at all — an async step (a digest,
 * a fetch) would lose the transaction mid-walk.
 *
 * The delta log travels too. A record that carried one is a document whose
 * snapshot alone is not its current state, so leaving the log behind would
 * silently roll every unsaved edit back.
 */
function carryLoroDocuments(tx: IDBTransaction, done: () => void): void {
  const loro = tx.objectStore('loroDocuments')
  const sync = tx.objectStore(SYNC_DOCUMENTS_STORE)
  const stamps = tx.objectStore(CONTENT_TIMESTAMPS_STORE)
  const cursorReq = loro.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      // Only once the walk is done: deleting the store mid-cursor would end
      // the walk with records still uncarried.
      tx.db.deleteObjectStore('loroDocuments')
      done()
      return
    }
    const documentId = String(cursor.primaryKey)
    const parsed = loroRecordEnvelopeSchema.safeParse(cursor.value)
    if (!parsed.success) {
      // Carried VERBATIM rather than skipped. A record this build cannot
      // parse is one written by a newer one, or one that is damaged — and
      // both are things `loadSnapshot` reports as an unreadable document,
      // which is a recoverable answer. Skipping it here would delete it with
      // the store at the end of this walk, turning "your build is old" into
      // "your document is gone" and destroying the bytes on the way.
      sync.put(cursor.value, `document:${documentId}`)
      cursor.continue()
      return
    }
    {
      const { manifest, chunks } = chunkSnapshot(parsed.data.snapshot, LEGACY_MAX_CHUNK_BYTES)
      sync.put(
        {
          v: 1,
          snapshot: { manifest, chunks },
          // Empty, matching what `LoroStore` writes: nothing in the browser
          // reads a frontier, and inventing one on migration would be a value
          // the first real reader has to unpick.
          frontier: new Uint8Array(),
          deltas: parsed.data.deltas ?? [],
        },
        `document:${documentId}`,
      )
      stamps.put(parsed.data.updatedAt, documentId)
    }
    cursor.continue()
  }
}

/**
 * True for a record written under the v12 envelope, whatever else is wrong
 * with it.
 *
 * Deliberately shallower than `syncRecordSchema`: this decides whether a value
 * is THIS migration's to rewrite, and a record whose snapshot is damaged is
 * still one whose envelope has to move forward — leaving it at v1 would change
 * `malformed` into `unsupported-version`, which tells the user the opposite
 * thing about why their document will not open. A record carried across
 * VERBATIM by v12 (one it could not parse either) has no `v: 1` and is left
 * exactly where it is.
 */
function isEnvelopeV1(value: unknown): value is { v: 1; snapshot: unknown } {
  return typeof value === 'object' && value !== null && (value as { v?: unknown }).v === 1
}

/**
 * Moves every v12 record's inline chunks into `syncSnapshotChunks` and bumps
 * the envelope to v2.
 *
 * Ordered AFTER `carryLoroDocuments` rather than beside it, for the reason
 * every carrier in this file is ordered: it walks the store that carrier is
 * still filling, and a cursor opened while those puts are queued sees an empty
 * store, splits nothing, and looks exactly like a successful upgrade — leaving
 * v1 records the new parser reports as unreadable documents.
 */
function splitInlineSnapshotChunks(tx: IDBTransaction, done: () => void): void {
  const sync = tx.objectStore(SYNC_DOCUMENTS_STORE)
  const chunks = tx.objectStore(SYNC_SNAPSHOT_CHUNKS_STORE)
  const cursorReq = sync.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      done()
      return
    }
    const record = cursor.value
    if (isEnvelopeV1(record)) {
      const snapshot = record.snapshot as { manifest?: unknown; chunks?: unknown } | null
      const inline = snapshot === null ? undefined : snapshot.chunks
      if (Array.isArray(inline)) {
        for (const chunk of inline) chunks.put(chunk, [cursor.primaryKey, chunk.index])
        cursor.update({ ...record, v: 2, snapshot: { manifest: snapshot?.manifest } })
      } else {
        cursor.update({ ...record, v: 2 })
      }
    }
    cursor.continue()
  }
}

/**
 * The literal key the browser's single workspace lived under before v14.
 * Spelled out rather than imported from anywhere else: this migration's job
 * is to make the string stop meaning anything, and a migration's own text is
 * history that names the shape it found, the way `defaultCanvasId` still
 * does in the v6->v7 rename above.
 */
const LEGACY_BROWSER_WORKSPACE_ID = 'local'

/**
 * Re-keys the browser's one workspace off `'local'` onto a canonical ULID —
 * the registry row, every `documentIndex` row it owns, and the
 * `workspace-tree:local` sync record plus its chunk rows.
 *
 * Convergent, not run-once, because it CANNOT assume it runs exactly once:
 * `backfillDocumentIndex` (v9->v10, above) unconditionally re-puts
 * `{workspaceId:'local'}` under key `'local'` on every future upgrade — it
 * has no way to know this step exists — so a later multi-version jump
 * resurrects the very row this step just deleted, inside the SAME
 * transaction, ordered right before it. The fix is not to skip when a ULID
 * row already exists (that would leave the resurrected `'local'` row behind
 * forever); it is to look for an existing target on every run and absorb
 * whatever `'local'` remnant is present into it, minting a new id only when
 * no target exists yet. Ordered last in the upgrade chain for the reason
 * every carrier here is: it reads what `backfillDocumentIndex` just wrote.
 *
 * Exported (only `browser-idb-migration.browser.test.tsx` imports it): the
 * convergence property this exists for can only be observed by running this
 * step a second time, and `backfillDocumentIndex`'s re-put depends on stores
 * (`documents`, `loroDocuments`) that no longer exist by v14 — replaying the
 * WHOLE upgrade chain a second time throws on those, where a real future
 * migration would still have them. Invoking this one step directly, against
 * a manually re-seeded `'local'` remnant, tests the real convergence logic
 * without needing a real v15 to reach it.
 */
export function rekeyBrowserWorkspace(tx: IDBTransaction, done: () => void): void {
  const workspaces = tx.objectStore(WORKSPACES_STORE)
  const index = tx.objectStore(DOCUMENT_INDEX_STORE)
  const sync = tx.objectStore(SYNC_DOCUMENTS_STORE)
  const chunks = tx.objectStore(SYNC_SNAPSHOT_CHUNKS_STORE)

  const keysReq = workspaces.getAllKeys()
  keysReq.onsuccess = () => {
    const keys = keysReq.result.map(String)
    const hasLegacyRemnant = keys.includes(LEGACY_BROWSER_WORKSPACE_ID)
    const targetId = keys.find((key) => key !== LEGACY_BROWSER_WORKSPACE_ID) ?? generateDocumentId()

    if (!hasLegacyRemnant) {
      // Nothing to absorb this pass. A brand-new database (no row at all)
      // still needs its registry row written; an already-converged one is
      // left alone rather than re-put on every upgrade.
      if (keys.length === 0) workspaces.put({ workspaceId: targetId }, targetId)
      done()
      return
    }

    workspaces.delete(LEGACY_BROWSER_WORKSPACE_ID)
    workspaces.put({ workspaceId: targetId }, targetId)
    rekeyLegacyIndexRows(index, targetId, () => rekeyLegacySyncTree(sync, chunks, targetId, done))
  }
}

/** Moves every `documentIndex` row keyed under the legacy workspace onto `targetId`. */
function rekeyLegacyIndexRows(index: IDBObjectStore, targetId: string, done: () => void): void {
  const range = IDBKeyRange.bound([LEGACY_BROWSER_WORKSPACE_ID], [LEGACY_BROWSER_WORKSPACE_ID, []])
  const cursorReq = index.openCursor(range)
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      done()
      return
    }
    const row = cursor.value as Record<string, unknown>
    cursor.delete()
    // The new key's first element is `targetId`, entirely outside the
    // `'local'` range this cursor walks, so the add cannot be observed by
    // this same cursor and cannot loop.
    index.add({ ...row, workspaceId: targetId })
    cursor.continue()
  }
}

/**
 * Moves the `workspace-tree:local` sync record and its `syncSnapshotChunks`
 * rows onto `workspace-tree:<targetId>`, as opaque values — no Loro decode,
 * matching every other carrier in this file that only needs to relocate
 * bytes it does not need to understand.
 */
function rekeyLegacySyncTree(
  sync: IDBObjectStore,
  chunks: IDBObjectStore,
  targetId: string,
  done: () => void,
): void {
  const legacyKey = `workspace-tree:${LEGACY_BROWSER_WORKSPACE_ID}`
  const targetKey = `workspace-tree:${targetId}`
  const getReq = sync.get(legacyKey)
  getReq.onsuccess = () => {
    const value = getReq.result
    if (value === undefined) {
      done()
      return
    }
    sync.delete(legacyKey)
    sync.put(value, targetKey)
    const chunkRange = IDBKeyRange.bound([legacyKey], [legacyKey, []])
    const cursorReq = chunks.openCursor(chunkRange)
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor) {
        done()
        return
      }
      const [, chunkIndex] = cursor.primaryKey as [string, number]
      const chunkValue = cursor.value
      cursor.delete()
      chunks.add(chunkValue, [targetKey, chunkIndex])
      cursor.continue()
    }
  }
}

function backfillDocumentIndex(tx: IDBTransaction, done: () => void): void {
  const documents = tx.objectStore('documents')
  const workspaces = tx.objectStore(WORKSPACES_STORE)
  const index = tx.objectStore(DOCUMENT_INDEX_STORE)
  workspaces.put({ workspaceId: 'local' }, 'local')
  const cursorReq = documents.openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor) {
      // Only once the walk is done: deleting the store mid-cursor would end
      // the walk with rows still uncopied.
      tx.db.deleteObjectStore('documents')
      done()
      return
    }
    const row = cursor.value
    if (isPathAddressed(row)) {
      const { workspaceId, documentId, path, kind, name } = row
      workspaces.put({ workspaceId }, workspaceId)
      index.put({
        workspaceId,
        documentId,
        path,
        kind,
        ...(name === undefined || name === path ? {} : { name }),
      })
    }
    cursor.continue()
  }
}

function renameMetaKey(tx: IDBTransaction, from: string, to: string): void {
  const meta = tx.objectStore('meta')
  const req = meta.get(from)
  req.onsuccess = () => {
    if (req.result === undefined) return
    meta.put(req.result, to)
    meta.delete(from)
  }
}

export function openWhiteboardDb(dbName: string = activeDbName): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      for (const [, to] of RENAMED_STORES) {
        if (!db.objectStoreNames.contains(to)) db.createObjectStore(to)
      }
      // Guarded: deleteObjectStore on a store that does not exist throws and
      // aborts the whole upgrade transaction, which would brick the DB open
      // for a fresh install (oldVersion 0) or any DB that never reached v5.
      if (db.objectStoreNames.contains('reconnectKeypairs')) {
        db.deleteObjectStore('reconnectKeypairs')
      }
      if (!db.objectStoreNames.contains(WORKSPACES_STORE)) db.createObjectStore(WORKSPACES_STORE)
      if (!db.objectStoreNames.contains(BLOBS_STORE)) db.createObjectStore(BLOBS_STORE)
      if (!db.objectStoreNames.contains(SYNC_DOCUMENTS_STORE)) {
        db.createObjectStore(SYNC_DOCUMENTS_STORE)
      }
      if (!db.objectStoreNames.contains(SYNC_SNAPSHOT_CHUNKS_STORE)) {
        db.createObjectStore(SYNC_SNAPSHOT_CHUNKS_STORE)
      }
      if (!db.objectStoreNames.contains(CONTENT_TIMESTAMPS_STORE)) {
        db.createObjectStore(CONTENT_TIMESTAMPS_STORE)
      }
      if (!db.objectStoreNames.contains(DOCUMENT_INDEX_STORE)) {
        const index = db.createObjectStore(DOCUMENT_INDEX_STORE, {
          keyPath: ['workspaceId', 'path'],
        })
        index.createIndex('byId', ['workspaceId', 'documentId'], { unique: true })
      }

      // req.transaction is always non-null inside onupgradeneeded; narrowed for TS.
      const tx = req.transaction
      if (!tx) return
      renameMetaKey(tx, 'defaultCanvasId', 'defaultDocumentId')
      // The discard runs only once every rename copy has drained, because it
      // walks the store those copies are still filling. Calling it beside them
      // is NOT equivalent: a cursor opened while the copy's puts are still
      // queued in their own callbacks sees an empty store, deletes nothing,
      // and looks exactly like a successful upgrade. Measured — a v6 pre-path
      // row survived a v6->v8 open until this was ordered.
      let pendingCopies = RENAMED_STORES.length
      const onCopyDone = () => {
        pendingCopies -= 1
        if (pendingCopies === 0) {
          // Ordered, for the same reason the discard is: the backfill walks
          // `documents`, which the rename copies are still filling, and the
          // discard decides which of those rows are worth carrying. Reading
          // before either drains sees an empty store and silently indexes
          // nothing.
          discardPrePathDocuments(tx, () =>
            backfillDocumentIndex(tx, () =>
              carryLoroDocuments(tx, () =>
                splitInlineSnapshotChunks(tx, () => rekeyBrowserWorkspace(tx, () => {})),
              ),
            ),
          )
        }
      }
      for (const [from, to] of RENAMED_STORES) copyStoreThenDelete(db, tx, from, to, onCopyDone)
    }
    req.onsuccess = () => {
      const db = req.result
      // Without this, an idle tab holding an older version blocks every newer
      // tab's upgrade until someone closes it — the connection has no reason
      // to outlive the schema it was opened against.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    // The request is not aborted by this rejection: if the blocking tab later
    // closes, `onsuccess` still runs and opens a connection nobody holds. That
    // is deliberately left alone rather than closed — the `onversionchange`
    // handler above is set on it too, so it steps aside for the next upgrade
    // or delete, which is the only harm an unowned connection can do here.
    req.onblocked = () =>
      reject(new Error('another tab has this app open at an older version; close it and reload'))
    req.onerror = () => reject(req.error)
  })
}
